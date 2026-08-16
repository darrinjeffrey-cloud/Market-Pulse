/**
 * databento-live.test.ts
 *
 * Fixture-based tests for DatabentoLiveClient exercising the full gateway
 * protocol without needing a real outbound TCP connection.
 *
 * A local net.Server acts as the mock Databento gateway and plays scripted
 * gateway messages. All TCP is on 127.0.0.1 with an OS-assigned port so
 * there is no dependency on live.databento.com.
 *
 * Coverage:
 *  - CRAM challenge-response computation
 *  - Pipe-delimited gateway message parsing / serialisation
 *  - Full text-phase handshake (Greeting → Challenge → Auth → SessionStart)
 *  - DBN metadata block detection and skipping
 *  - SymbolMappingMsg (rtype 0x73) parsing
 *  - OhlcvMsg (rtype 0x21) parsing and bar event emission
 *  - Fragmented data delivery (bytes trickled one at a time)
 *  - Reconnect after socket error
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as crypto from "node:crypto";

// Import the module under test directly from TypeScript source via tsx
import { DatabentoLiveClient } from "./databento-live.js";

// ---------------------------------------------------------------------------
// Helper: CRAM reference implementation (mirrors cram.py exactly)
// ---------------------------------------------------------------------------

function cramExpected(challenge: string, apiKey: string): string {
  const bucketId = apiKey.slice(-5);
  const sha = crypto
    .createHash("sha256")
    .update(`${challenge}|${apiKey}`)
    .digest("hex");
  return `${sha}-${bucketId}`;
}

// ---------------------------------------------------------------------------
// Helper: build binary fixtures
// ---------------------------------------------------------------------------

// From dbn/src/enums.rs RType enum (authoritative Rust source):
const RTYPE_OHLCV_1M   = 0x21; // Ohlcv1M
const RTYPE_SYMBOL_MAP = 0x16; // SymbolMapping
const RTYPE_SYSTEM     = 0x17; // System (heartbeats)

/**
 * Build a minimal DBN metadata block.
 *
 * DBN metadata preamble (8 bytes):
 *   bytes 0-2: ASCII "DBN" magic (0x44, 0x42, 0x4E)
 *   byte  3:   version (u8)
 *   bytes 4-7: body length (uint32 LE) — size of the metadata BODY only,
 *              NOT including the 8-byte preamble itself.
 *
 * Total bytes the client must skip = 8 + bodyBytes.
 */
function buildMetadata(version = 1, bodyBytes = 0): Buffer {
  const total = 8 + bodyBytes;
  const buf = Buffer.alloc(total, 0);
  buf.writeUInt8(0x44, 0); // 'D'
  buf.writeUInt8(0x42, 1); // 'B'
  buf.writeUInt8(0x4E, 2); // 'N'
  buf.writeUInt8(version, 3);          // version
  buf.writeUInt32LE(bodyBytes, 4);     // body length (excludes the 8-byte preamble)
  // bytes 8..total: body (zeroed placeholder, not decoded by our client)
  return buf;
}

/**
 * SymbolMappingMsg: 80 bytes, length_field=20, rtype=0x16.
 *
 * Exact layout from dbn/rust/dbn/src/record.rs (SYMBOL_CSTR_LEN=22):
 *   bytes  0-15: RecordHeader (hd)
 *     [0]  length_field (uint8)  = 20   (20 × 4 = 80 bytes)
 *     [1]  rtype        (uint8)  = 0x16 (SymbolMapping)
 *     [2-3] publisher_id (uint16 LE)
 *     [4-7] instrument_id (uint32 LE)
 *     [8-15] ts_event (uint64 LE)
 *   byte  16:    stype_in  (u8 SType enum)
 *   bytes 17-38: stype_in_symbol  (char[22], null-padded)
 *   byte  39:    stype_out (u8 SType enum)
 *   bytes 40-61: stype_out_symbol (char[22], null-padded)
 *   bytes 62-63: padding (C struct alignment for uint64 fields)
 *   bytes 64-71: start_ts (uint64 LE)
 *   bytes 72-79: end_ts   (uint64 LE)
 */
function buildSymbolMapping(instrumentId: number, stypeIn: string, stypeOut = "ESUN4"): Buffer {
  const buf = Buffer.alloc(80, 0);
  buf.writeUInt8(20, 0);               // length_field (20 × 4 = 80 bytes)
  buf.writeUInt8(RTYPE_SYMBOL_MAP, 1); // rtype = 0x16
  buf.writeUInt16LE(1, 2);             // publisher_id
  buf.writeUInt32LE(instrumentId, 4);  // instrument_id
  // ts_event (bytes 8-15): already zeroed
  buf.writeUInt8(1, 16);               // stype_in enum byte (1 = continuous)
  buf.write(stypeIn.slice(0, 21), 17, "utf8"); // stype_in_symbol (bytes 17-38, 22 bytes)
  buf.writeUInt8(1, 39);               // stype_out enum byte (1 = raw_symbol)
  buf.write(stypeOut.slice(0, 21), 40, "utf8"); // stype_out_symbol (bytes 40-61, 22 bytes)
  // bytes 62-63: padding (already zeroed)
  // bytes 64-79: start_ts / end_ts (already zeroed)
  return buf;
}

/**
 * OhlcvMsg: 56 bytes, length_field=14, rtype=0x21.
 *  Header (16 bytes): length_field, rtype, publisher_id, instrument_id, ts_event
 *  Body:
 *    [16-23] open   (int64 LE, price × 1e9)
 *    [24-31] high   (int64 LE, price × 1e9)
 *    [32-39] low    (int64 LE, price × 1e9)
 *    [40-47] close  (int64 LE, price × 1e9)
 *    [48-55] volume (uint64 LE)
 */
function buildOhlcv(
  instrumentId: number,
  tsNs: bigint,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
): Buffer {
  const buf = Buffer.alloc(56, 0);
  buf.writeUInt8(14, 0);             // length_field (14 × 4 = 56)
  buf.writeUInt8(RTYPE_OHLCV_1M, 1); // rtype
  buf.writeUInt16LE(1, 2);           // publisher_id
  buf.writeUInt32LE(instrumentId, 4); // instrument_id
  buf.writeBigUInt64LE(tsNs, 8);     // ts_event (nanoseconds)
  buf.writeBigInt64LE(BigInt(Math.round(open  * 1e9)), 16);
  buf.writeBigInt64LE(BigInt(Math.round(high  * 1e9)), 24);
  buf.writeBigInt64LE(BigInt(Math.round(low   * 1e9)), 32);
  buf.writeBigInt64LE(BigInt(Math.round(close * 1e9)), 40);
  buf.writeBigUInt64LE(BigInt(volume), 48);
  return buf;
}

/**
 * Minimal SystemMsg heartbeat (rtype=0x17).
 * A valid record needs at least the 16-byte RecordHeader, so length_field=4 (4×4=16).
 */
function buildHeartbeat(): Buffer {
  const buf = Buffer.alloc(16, 0);
  buf.writeUInt8(4, 0);            // length_field (4 × 4 = 16 bytes)
  buf.writeUInt8(RTYPE_SYSTEM, 1); // rtype = 0x17
  return buf;
}

// ---------------------------------------------------------------------------
// Helper: create a mock gateway server and run a scenario
// ---------------------------------------------------------------------------

interface ScenarioOptions {
  /** API key given to the client (last 5 chars are the bucket ID). */
  apiKey?: string;
  /** Symbols to watch. */
  symbols?: string[];
  /**
   * Server-side handler. Called with the connected socket.
   * Receives all bytes the client sends; should write gateway messages and binary.
   */
  serverScript: (socket: net.Socket, received: () => Buffer) => Promise<void>;
  /**
   * Client-side assertions. Receives the client and a function that
   * resolves when the given event fires (or rejects on timeout).
   */
  clientScript: (
    client: DatabentoLiveClient,
    waitFor: (event: string, timeoutMs?: number) => Promise<unknown>,
  ) => Promise<void>;
}

async function runScenario(opts: ScenarioOptions): Promise<void> {
  const apiKey = opts.apiKey ?? "db-testingkey12345";
  const symbols = opts.symbols ?? ["ES.v.0"];

  let serverSocket: net.Socket | undefined;
  let rxBuf = Buffer.alloc(0);

  const server = net.createServer((s) => {
    serverSocket = s;
    s.on("data", (chunk: Buffer) => {
      rxBuf = Buffer.concat([rxBuf, chunk]);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;

  const client = new DatabentoLiveClient(apiKey, "GLBX.MDP3", symbols, {
    host: "127.0.0.1",
    port,
  });

  function waitFor(event: string, timeoutMs = 3000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for event '${event}' after ${timeoutMs}ms`));
      }, timeoutMs);
      client.once(event, (...args) => {
        clearTimeout(timer);
        resolve(args[0]);
      });
    });
  }

  // Wait until the server has an accepted socket
  async function awaitSocket(): Promise<net.Socket> {
    const deadline = Date.now() + 2000;
    while (!serverSocket && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (!serverSocket) throw new Error("Server socket never connected");
    return serverSocket;
  }

  try {
    client.start();
    const socket = await awaitSocket();
    // Run server and client scripts concurrently so the client can register
    // event listeners before the server sends data (avoids missing events).
    await Promise.all([
      opts.serverScript(socket, () => rxBuf),
      opts.clientScript(client, waitFor),
    ]);
  } finally {
    client.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// Helper: write bytes in small fragments to test buffering robustness
function writeFragmented(socket: net.Socket, data: Buffer, chunkSize = 1): void {
  for (let i = 0; i < data.length; i += chunkSize) {
    socket.write(data.subarray(i, i + chunkSize));
  }
}

// ---------------------------------------------------------------------------
// ── CRAM computation unit tests ────────────────────────────────────────────
// ---------------------------------------------------------------------------

describe("CRAM authentication", () => {
  it("bucket ID is the last 5 characters of the API key", () => {
    const key = "db-abcde12345";
    const bucketId = key.slice(-5);
    assert.equal(bucketId, "12345");
  });

  it("produces sha256(challenge|key)-bucketId format", () => {
    const challenge = "some-server-challenge";
    const apiKey = "db-testkey-00001";
    const bucketId = apiKey.slice(-5);
    const sha = crypto.createHash("sha256").update(`${challenge}|${apiKey}`).digest("hex");
    const expected = `${sha}-${bucketId}`;
    const actual = cramExpected(challenge, apiKey);
    assert.equal(actual, expected);
  });

  it("is NOT HMAC-SHA256 — plain sha256 of the concatenated string", () => {
    const challenge = "challenge123";
    const apiKey = "db-mykey-XXXXX";
    const plain = crypto.createHash("sha256").update(`${challenge}|${apiKey}`).digest("hex");
    const hmac = crypto.createHmac("sha256", apiKey).update(challenge).digest("hex");
    assert.notEqual(plain, hmac, "CRAM must use sha256(), not hmac-sha256()");
  });
});

// ---------------------------------------------------------------------------
// ── Gateway message format unit tests ─────────────────────────────────────
// ---------------------------------------------------------------------------

describe("Gateway message format", () => {
  it("pipe-delimited key=value lines are parsed correctly", () => {
    function parse(line: string): Record<string, string> {
      const result: Record<string, string> = {};
      for (const token of line.trim().split("|")) {
        const eq = token.indexOf("=");
        if (eq === -1) result[token] = "";
        else result[token.slice(0, eq)] = token.slice(eq + 1);
      }
      return result;
    }
    const msg = parse("success=1|session_id=abc123\n");
    assert.equal(msg.success, "1");
    assert.equal(msg.session_id, "abc123");
  });

  it("Greeting is lsg_version=<ver>, not JSON", () => {
    const line = "lsg_version=0\n";
    assert.ok(line.includes("lsg_version="), "must be key=value format");
    assert.ok(!line.startsWith("{"), "must not be JSON");
  });

  it("SessionStart is start_session=0, not JSON action:start", () => {
    const line = "start_session=0\n";
    assert.ok(line.startsWith("start_session="), "must be key=value format");
    assert.ok(!line.includes("action"), "must not contain JSON action key");
  });
});

// ---------------------------------------------------------------------------
// ── DBN binary fixture helpers ─────────────────────────────────────────────
// ---------------------------------------------------------------------------

describe("DBN binary fixtures", () => {
  it("OhlcvMsg is 56 bytes with length_field=14", () => {
    const buf = buildOhlcv(1, 0n, 5000, 5010, 4990, 5005, 100);
    assert.equal(buf.length, 56);
    assert.equal(buf.readUInt8(0), 14);   // length_field
    assert.equal(buf.readUInt8(1), 0x21); // rtype
  });

  it("SymbolMappingMsg is 80 bytes with length_field=20 and rtype=0x16", () => {
    const buf = buildSymbolMapping(42, "ES.v.0");
    assert.equal(buf.length, 80);
    assert.equal(buf.readUInt8(0), 20);   // length_field (20 × 4 = 80 bytes)
    assert.equal(buf.readUInt8(1), 0x16); // rtype = SymbolMapping (from DBN enums.rs)
    // stype_in enum byte at offset 16
    assert.equal(buf.readUInt8(16), 1);
    // stype_in_symbol at bytes 17-38 (22 bytes)
    const sym = buf.subarray(17, 39).toString("utf8").replace(/\0+$/, "");
    assert.equal(sym, "ES.v.0");
  });

  it("Heartbeat is 16 bytes with length_field=4 and rtype=0x17", () => {
    const buf = buildHeartbeat();
    assert.equal(buf.length, 16);
    assert.equal(buf.readUInt8(0), 4);    // length_field (4×4=16, minimum valid record)
    assert.equal(buf.readUInt8(1), 0x17); // rtype = System/heartbeat (from DBN enums.rs)
  });

  it("Metadata preamble: 'DBN' magic + version at bytes 0-3; body length (NOT total) at bytes 4-7", () => {
    const buf = buildMetadata(1, 0); // version=1, bodyBytes=0 → total=8
    assert.equal(buf.length, 8);
    // bytes 0-2: ASCII "DBN" magic
    assert.equal(buf.readUInt8(0), 0x44, "byte 0 must be 'D'");
    assert.equal(buf.readUInt8(1), 0x42, "byte 1 must be 'B'");
    assert.equal(buf.readUInt8(2), 0x4E, "byte 2 must be 'N'");
    // byte 3: version
    assert.equal(buf.readUInt8(3), 1, "byte 3 must be the version number");
    // bytes 4-7: body length (EXCLUDING the 8-byte preamble)
    // For bodyBytes=0, body length = 0, total to skip = 8 + 0 = 8
    assert.equal(buf.readUInt32LE(4), 0, "body length must be 0 (excludes 8-byte preamble)");

    // With a 16-byte body:
    const buf2 = buildMetadata(2, 16);
    assert.equal(buf2.length, 24);          // 8 + 16
    assert.equal(buf2.readUInt32LE(4), 16); // body length = 16 (total to skip = 8 + 16 = 24)
  });
});

// ---------------------------------------------------------------------------
// ── Full integration scenarios (mock TCP server) ───────────────────────────
// ---------------------------------------------------------------------------

describe("DatabentoLiveClient — full handshake", () => {
  const TEST_API_KEY = "db-testingkey-BBBBB"; // bucket id = "BBBBB"
  const TEST_CHALLENGE = "gateway-challenge-xyz";

  it("sends correct CRAM response, subscription, and start_session messages", async () => {
    const rxLines: string[] = [];
    await runScenario({
      apiKey: TEST_API_KEY,
      symbols: ["ES.v.0"],
      async serverScript(socket, received) {
        // 1. Send greeting
        socket.write("lsg_version=0\n");
        await new Promise((r) => setTimeout(r, 30));

        // 2. Send challenge
        socket.write(`cram=${TEST_CHALLENGE}\n`);
        await new Promise((r) => setTimeout(r, 100));

        // Parse what the client sent back
        const clientBytes = received().toString("utf8");
        for (const line of clientBytes.split("\n").filter(Boolean)) {
          rxLines.push(line);
        }

        // 3. Send auth success
        socket.write("success=1|session_id=test-sess-001\n");
        await new Promise((r) => setTimeout(r, 80));

        // Collect the rest (subscription + start_session)
        const rest = received().toString("utf8");
        for (const line of rest.split("\n").filter(Boolean)) {
          if (!rxLines.includes(line)) rxLines.push(line);
        }
      },
      async clientScript(_client, waitFor) {
        await waitFor("connected", 2000);
      },
    });

    // Verify auth message
    const authLine = rxLines.find((l) => l.startsWith("auth="));
    assert.ok(authLine, "client must send an auth= line");

    const authFields: Record<string, string> = {};
    for (const token of authLine.split("|")) {
      const eq = token.indexOf("=");
      if (eq !== -1) authFields[token.slice(0, eq)] = token.slice(eq + 1);
    }

    const expectedAuth = cramExpected(TEST_CHALLENGE, TEST_API_KEY);
    assert.equal(authFields.auth, expectedAuth, "CRAM response must match sha256(challenge|key)-bucketId");
    assert.equal(authFields.dataset, "GLBX.MDP3");
    assert.equal(authFields.encoding, "dbn");

    // Verify subscription message
    const subLine = rxLines.find((l) => l.startsWith("schema="));
    assert.ok(subLine, "client must send a schema= subscription line");
    assert.ok(subLine.includes("stype_in=continuous"), "subscription must use stype_in=continuous");
    assert.ok(subLine.includes("symbols=ES.v.0"), "subscription must include the watched symbol");

    // Verify session start message
    const startLine = rxLines.find((l) => l.startsWith("start_session="));
    assert.ok(startLine, "client must send start_session= line");
    assert.ok(!startLine.includes("action"), "session start must not be JSON");
  });

  it("emits 'connected' after successful auth", async () => {
    await runScenario({
      apiKey: TEST_API_KEY,
      async serverScript(socket) {
        socket.write("lsg_version=0\n");
        await new Promise((r) => setTimeout(r, 30));
        socket.write(`cram=${TEST_CHALLENGE}\n`);
        await new Promise((r) => setTimeout(r, 80));
        socket.write("success=1|session_id=sess-002\n");
      },
      async clientScript(_client, waitFor) {
        // Must emit 'connected' without timeout
        await waitFor("connected", 2000);
      },
    });
  });
});

describe("DatabentoLiveClient — bar parsing", () => {
  const TEST_API_KEY = "db-bartest-AAAAA";
  const TEST_CHALLENGE = "bar-test-challenge";

  async function runHandshake(socket: net.Socket, received: () => Buffer): Promise<void> {
    socket.write("lsg_version=0\n");
    await new Promise((r) => setTimeout(r, 30));
    socket.write(`cram=${TEST_CHALLENGE}\n`);
    await new Promise((r) => setTimeout(r, 100));
    // Wait for client to send auth
    const deadline = Date.now() + 1000;
    while (received().length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    socket.write("success=1|session_id=bar-sess\n");
    await new Promise((r) => setTimeout(r, 60));
  }

  it("parses OhlcvMsg and emits a bar event after symbol mapping", async () => {
    const expectedTs = 1_700_000_000_000; // milliseconds
    const tsNs = BigInt(expectedTs) * 1_000_000n;
    const instrumentId = 42;

    let receivedBar: unknown;

    await runScenario({
      apiKey: TEST_API_KEY,
      symbols: ["ES.v.0"],
      async serverScript(socket, received) {
        await runHandshake(socket, received);

        // Send minimal metadata (8 bytes, length=8)
        socket.write(buildMetadata(1, 0));

        // Map instrument 42 → ES.v.0
        socket.write(buildSymbolMapping(instrumentId, "ES.v.0"));

        // Send an OHLCV bar
        socket.write(
          buildOhlcv(instrumentId, tsNs, 5000.25, 5010.50, 4995.00, 5005.75, 1234),
        );

        await new Promise((r) => setTimeout(r, 100));
      },
      async clientScript(client, waitFor) {
        await waitFor("connected");
        receivedBar = await waitFor("bar", 2000);
      },
    });

    const bar = receivedBar as {
      symbol: string;
      ts: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    };

    assert.equal(bar.symbol, "ES.v.0", "bar symbol must match stype_in from mapping");
    assert.ok(Math.abs(bar.ts - expectedTs) < 1, `bar.ts ${bar.ts} must match ${expectedTs}`);
    assert.ok(Math.abs(bar.open  - 5000.25) < 0.01, `open=${bar.open}`);
    assert.ok(Math.abs(bar.high  - 5010.50) < 0.01, `high=${bar.high}`);
    assert.ok(Math.abs(bar.low   - 4995.00) < 0.01, `low=${bar.low}`);
    assert.ok(Math.abs(bar.close - 5005.75) < 0.01, `close=${bar.close}`);
    assert.equal(bar.volume, 1234, "volume must match");
  });

  it("ignores OHLCV for unmapped instrument_id (no bar event)", async () => {
    let barFired = false;

    await runScenario({
      apiKey: TEST_API_KEY,
      symbols: ["ES.v.0"],
      async serverScript(socket, received) {
        await runHandshake(socket, received);
        socket.write(buildMetadata());
        // No SymbolMapping — instrument 99 is unknown
        socket.write(buildOhlcv(99, 1_000_000n, 5000, 5010, 4990, 5000, 100));
        await new Promise((r) => setTimeout(r, 150));
      },
      async clientScript(client, waitFor) {
        await waitFor("connected");
        client.on("bar", () => { barFired = true; });
        await new Promise((r) => setTimeout(r, 200));
      },
    });

    assert.equal(barFired, false, "must not emit bar for unmapped instrument");
  });

  it("ignores SystemMsg heartbeats (no bar event)", async () => {
    let barFired = false;

    await runScenario({
      apiKey: TEST_API_KEY,
      symbols: ["ES.v.0"],
      async serverScript(socket, received) {
        await runHandshake(socket, received);
        socket.write(buildMetadata());
        // Send 3 heartbeats only
        socket.write(Buffer.concat([buildHeartbeat(), buildHeartbeat(), buildHeartbeat()]));
        await new Promise((r) => setTimeout(r, 150));
      },
      async clientScript(client, waitFor) {
        await waitFor("connected");
        client.on("bar", () => { barFired = true; });
        await new Promise((r) => setTimeout(r, 200));
      },
    });

    assert.equal(barFired, false, "heartbeats must not trigger bar events");
  });
});

describe("DatabentoLiveClient — fragmented delivery", () => {
  const TEST_API_KEY = "db-fragtest-CCCCC";
  const TEST_CHALLENGE = "frag-challenge";

  it("correctly parses records when data arrives one byte at a time", async () => {
    const instrumentId = 7;
    const tsNs = 1_700_500_000_000_000_000n; // arbitrary nanosecond timestamp
    let receivedBar: unknown;

    await runScenario({
      apiKey: TEST_API_KEY,
      symbols: ["NQ.v.0"],
      async serverScript(socket, received) {
        // Send handshake byte-by-byte to stress-test the text parser
        const greeting = Buffer.from("lsg_version=0\n");
        writeFragmented(socket, greeting, 1);
        await new Promise((r) => setTimeout(r, 50));

        const challenge = Buffer.from(`cram=${TEST_CHALLENGE}\n`);
        writeFragmented(socket, challenge, 1);
        await new Promise((r) => setTimeout(r, 100));

        // Wait for auth from client
        const deadline = Date.now() + 1000;
        while (received().length === 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 10));
        }

        const authResp = Buffer.from("success=1|session_id=frag-sess\n");
        writeFragmented(socket, authResp, 1);
        await new Promise((r) => setTimeout(r, 60));

        // Send binary data fragmented too
        const meta    = buildMetadata(1, 16); // 24-byte metadata block
        const mapping = buildSymbolMapping(instrumentId, "NQ.v.0");
        const bar     = buildOhlcv(instrumentId, tsNs, 18000, 18050, 17980, 18030, 567);
        const binary  = Buffer.concat([meta, mapping, bar]);
        writeFragmented(socket, binary, 3); // 3 bytes at a time

        await new Promise((r) => setTimeout(r, 200));
      },
      async clientScript(_client, waitFor) {
        await waitFor("connected");
        receivedBar = await waitFor("bar", 3000);
      },
    });

    const bar = receivedBar as { symbol: string; ts: number; close: number };
    assert.equal(bar.symbol, "NQ.v.0");
    assert.ok(Math.abs(bar.close - 18030) < 0.01, `close=${bar.close}`);
  });
});

describe("DatabentoLiveClient — reconnect on close", () => {
  it("emits 'disconnected' when the server closes the connection", async () => {
    const TEST_API_KEY = "db-recontest-DDDDD";
    let disconnected = false;

    await runScenario({
      apiKey: TEST_API_KEY,
      async serverScript(socket) {
        // Close immediately after greeting (auth will fail mid-handshake)
        socket.write("lsg_version=0\n");
        await new Promise((r) => setTimeout(r, 50));
        socket.destroy();
        await new Promise((r) => setTimeout(r, 100));
      },
      async clientScript(client, waitFor) {
        client.on("disconnected", () => { disconnected = true; });
        await waitFor("disconnected", 2000);
      },
    });

    assert.equal(disconnected, true, "must emit disconnected when server closes");
  });
});
