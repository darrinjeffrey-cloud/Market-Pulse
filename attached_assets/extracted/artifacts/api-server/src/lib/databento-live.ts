/**
 * databento-live.ts
 *
 * Databento Live gateway TCP client — correct wire protocol.
 *
 * ── Gateway control protocol (text phase) ─────────────────────────────────
 * All messages are pipe-delimited key=value pairs, newline-terminated:
 *   key1=val1|key2=val2\n
 *
 * Handshake sequence (server sends 3 lines total before binary starts):
 *  1. Server → Client:  lsg_version=<ver>\n              (Greeting)
 *  2. Server → Client:  cram=<challenge>\n               (ChallengeRequest)
 *  3. Client → Server:  auth=<response>|dataset=<ds>|encoding=dbn|ts_out=0|
 *                         heartbeat_interval_s=30|client=databento-node\n
 *  4. Server → Client:  success=1|session_id=<id>\n      (AuthResponse)
 *                   OR:  success=0|error=<msg>\n
 *  5. Client → Server:  schema=ohlcv-1m|stype_in=continuous|symbols=<sym>|
 *                         snapshot=0|is_last=1\n         (SubscriptionRequest)
 *  6. Client → Server:  start_session=0\n               (SessionStart)
 *
 * ── CRAM authentication ───────────────────────────────────────────────────
 * challenge_response = sha256("{challenge}|{apiKey}") + "-" + apiKey[-5:]
 * (SHA-256 of the pipe-joined string, then appended with bucket ID = last 5
 *  chars of the API key)
 *
 * ── Binary phase: DBN stream ─────────────────────────────────────────────
 * After SessionStart the server streams binary data in two stages:
 *  1. DBN metadata block — a fixed-size header describing the data stream:
 *       byte 0:    version (uint8)
 *       bytes 1-3: reserved (zeros)
 *       bytes 4-7: total length of this metadata block (uint32 LE) including
 *                  these 8 bytes — skip all `length` bytes before records
 *
 *  2. DBN records — each record starts with a 16-byte header:
 *       byte 0:   length field (uint8) — record size in 4-byte units
 *                 (actual byte count = length × 4)
 *       byte 1:   rtype (uint8) — record type
 *       bytes 2-3: publisher_id (uint16 LE)
 *       bytes 4-7: instrument_id (uint32 LE) — key for symbol mapping
 *       bytes 8-15: ts_event (uint64 LE, nanoseconds since epoch)
 *
 *     OhlcvMsg (rtype=0x21, 56 bytes, length_field=14):
 *       bytes 16-23: open   (int64 LE, price × 1e9)
 *       bytes 24-31: high   (int64 LE, price × 1e9)
 *       bytes 32-39: low    (int64 LE, price × 1e9)
 *       bytes 40-47: close  (int64 LE, price × 1e9)
 *       bytes 48-55: volume (uint64 LE)
 *
 *     SymbolMappingMsg (rtype=0x73, 76 bytes, length_field=19):
 *       bytes 16-37: stype_in_symbol  (char[22], null-padded)
 *       bytes 38-59: stype_out_symbol (char[22], null-padded)
 *       bytes 60-67: start_ts (uint64 LE)
 *       bytes 68-75: end_ts   (uint64 LE)
 *
 *     SystemMsg (rtype=0xF0) — heartbeats; length varies; ignored.
 */

import * as net from "net";
import * as crypto from "crypto";
import { EventEmitter } from "events";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// DBN record type constants — from the authoritative Rust enum in dbn/src/enums.rs
// ---------------------------------------------------------------------------
const RTYPE_OHLCV_1M   = 0x21; // 33  — Ohlcv1M: 1-minute OHLCV bar
const RTYPE_SYMBOL_MAP = 0x16; // 22  — SymbolMapping: instrument_id ↔ symbol mapping
const RTYPE_SYSTEM     = 0x17; // 23  — System: heartbeats / non-error gateway messages
const RTYPE_ERROR      = 0x15; // 21  — Error: error message from the gateway

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OhlcvBar {
  symbol: string;   // watched continuous symbol, e.g. "ES.v.0"
  ts: number;       // bar open timestamp, milliseconds since epoch
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ---------------------------------------------------------------------------
// Gateway message helpers
// ---------------------------------------------------------------------------

/**
 * Parse a pipe-delimited gateway control message into a key-value map.
 * Input:  "key1=val1|key2=val2\n"
 * Output: { key1: "val1", key2: "val2" }
 */
function parseGateway(line: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const token of line.trim().split("|")) {
    const eq = token.indexOf("=");
    if (eq === -1) {
      result[token] = "";
    } else {
      result[token.slice(0, eq)] = token.slice(eq + 1);
    }
  }
  return result;
}

/**
 * Serialize fields to a pipe-delimited gateway control message.
 * Omits any field whose value is null or undefined.
 */
function gatewayMsg(
  fields: Record<string, string | number | null | undefined>,
): string {
  return (
    Object.entries(fields)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .join("|") + "\n"
  );
}

// ---------------------------------------------------------------------------
// CRAM authentication
// ---------------------------------------------------------------------------

/**
 * Compute the Databento CRAM authentication response.
 *
 * response = sha256("{challenge}|{apiKey}") + "-" + apiKey[-5:]
 *
 * Differs from HMAC-SHA256: this is a plain SHA-256 of the concatenated
 * challenge and key, with the last 5 characters of the key as a "bucket ID"
 * suffix for routing.
 */
function cramResponse(challenge: string, apiKey: string): string {
  const bucketId = apiKey.slice(-5);
  const sha = crypto
    .createHash("sha256")
    .update(`${challenge}|${apiKey}`)
    .digest("hex");
  return `${sha}-${bucketId}`;
}

// ---------------------------------------------------------------------------
// DatabentoLiveClient
// ---------------------------------------------------------------------------

/**
 * Handshake state machine:
 *   GREETING        → waiting for lsg_version= line from server
 *   CHALLENGE       → received greeting, waiting for cram= line
 *   AUTH_SENT       → sent auth, waiting for success= line
 *   META_INIT       → text handshake done, reading first 8 bytes of DBN metadata
 *   META_BODY       → have metadata header, consuming body bytes
 *   RECORDS         → metadata consumed, parsing DBN records
 */
type HsState =
  | "GREETING"
  | "CHALLENGE"
  | "AUTH_SENT"
  | "META_INIT"
  | "META_BODY"
  | "RECORDS";

/**
 * EventEmitter-based Databento Live gateway client.
 *
 * Events:
 *   "bar"          (bar: OhlcvBar) — a completed 1m OHLCV bar
 *   "connected"    ()              — session started; binary stream active
 *   "disconnected" ()              — socket closed; will auto-reconnect
 */
export class DatabentoLiveClient extends EventEmitter {
  private socket: net.Socket | null = null;

  // Raw byte accumulator used throughout (both text and binary phases)
  private buf = Buffer.alloc(0);

  private hsState: HsState = "GREETING";

  // Set once we read the metadata length field (bytes 4-7)
  private metaLength = 0;

  // Maps Databento instrument_id → our watched continuous symbol
  private instrumentMap = new Map<number, string>();

  private destroyed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = 5_000; // doubles up to 60 s

  private readonly host: string;
  private readonly port: number;

  /**
   * Authoritative set of all symbols this client should subscribe to.
   * Seeded from the constructor array; grown by subscribeLiveSymbol().
   * Persists across reconnects so every reconnect replays the full current set.
   */
  private readonly activeSymbols: Set<string>;

  constructor(
    private readonly apiKey: string,
    private readonly dataset: string,
    symbols: string[],
    /** Override host/port for testing (default: {dataset}.lsg.databento.com:13000) */
    options?: { host?: string; port?: number },
  ) {
    super();
    this.activeSymbols = new Set(symbols);
    this.host = options?.host ?? `${dataset.toLowerCase().replace(".", "-")}.lsg.databento.com`;
    this.port = options?.port ?? 13000;
  }

  /** Open the connection and start the auto-reconnect loop. */
  start(): void {
    if (!this.destroyed) this.attemptConnect();
  }

  /** Permanently stop the client — no further reconnects. */
  stop(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.destroy();
    this.socket = null;
  }

  /**
   * Subscribe to an additional symbol on this client.
   *
   * The symbol is added to activeSymbols immediately so it is always included
   * in future reconnect subscriptions.
   *
   * If the session is already in streaming mode, a SubscriptionRequest is sent
   * right away so bars arrive without waiting for the next reconnect.
   *
   * If the session is still handshaking, no immediate write is made — the symbol
   * will be included in the initial SubscriptionRequest sent at AUTH_SENT success.
   */
  subscribeLiveSymbol(symbol: string): void {
    this.activeSymbols.add(symbol);

    const inStreamingState =
      this.hsState === "META_INIT" ||
      this.hsState === "META_BODY" ||
      this.hsState === "RECORDS";

    if (!this.socket || !inStreamingState) {
      logger.debug(
        { symbol, hsState: this.hsState },
        "Databento Live: symbol queued — will be included in next session start",
      );
      return;
    }

    logger.info({ symbol }, "Databento Live: subscribing new symbol on active session");
    this.socket.write(
      gatewayMsg({
        schema: "ohlcv-1m",
        stype_in: "continuous",
        symbols: symbol,
        snapshot: "0",
        is_last: "1",
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Connection management
  // ---------------------------------------------------------------------------

  private attemptConnect(): void {
    if (this.destroyed) return;

    // Reset per-connection state
    this.hsState = "GREETING";
    this.buf = Buffer.alloc(0);
    this.metaLength = 0;
    this.instrumentMap.clear();

    logger.info({ host: this.host, port: this.port }, "Databento Live: connecting");

    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;

    socket.on("data", (chunk: Buffer) => this.onData(chunk));

    socket.on("error", (err) => {
      logger.warn({ err }, "Databento Live: socket error");
      // 'close' fires after 'error' → reconnect is handled there
    });

    socket.on("close", () => {
      this.socket = null;
      this.emit("disconnected");
      if (!this.destroyed) {
        logger.info(
          { reconnectDelayMs: this.reconnectDelayMs },
          "Databento Live: disconnected — will reconnect",
        );
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 60_000);
          this.attemptConnect();
        }, this.reconnectDelayMs);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Data handler
  // ---------------------------------------------------------------------------

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    this.pump();
  }

  /** Main state-machine pump. Called whenever new bytes arrive. */
  private pump(): void {
    // Text handshake states: scan for newline-delimited gateway messages
    while (
      (this.hsState as string) === "GREETING" ||
      (this.hsState as string) === "CHALLENGE" ||
      (this.hsState as string) === "AUTH_SENT"
    ) {
      const nl = this.buf.indexOf(0x0A); // \n byte
      if (nl === -1) return; // wait for more data

      const line = this.buf.subarray(0, nl).toString("utf8").trim();
      this.buf = this.buf.subarray(nl + 1);

      if (line) this.handleTextLine(line);
    }

    // DBN metadata consumption states
    if ((this.hsState as string) === "META_INIT") {
      if (this.buf.length < 8) return; // need 8 bytes to read metadata preamble

      // DBN metadata preamble (8 bytes):
      //   bytes 0-2: ASCII "DBN" magic (0x44, 0x42, 0x4E)
      //   byte  3:   version (u8)
      //   bytes 4-7: body length (uint32 LE) — size of the metadata BODY only,
      //              NOT including these 8 preamble bytes
      //
      // Total bytes to consume = 8 (preamble) + body_length
      if (this.buf[0] !== 0x44 || this.buf[1] !== 0x42 || this.buf[2] !== 0x4E) {
        logger.warn(
          { preamble: this.buf.subarray(0, 4).toString("hex") },
          "Databento Live: unexpected DBN metadata magic — attempting to continue",
        );
      }
      const version = this.buf.readUInt8(3);
      const bodyLength = this.buf.readUInt32LE(4);
      this.metaLength = 8 + bodyLength; // preamble + body
      logger.debug(
        { version, bodyLength, totalToSkip: this.metaLength },
        "Databento Live: DBN metadata header",
      );
      this.hsState = "META_BODY";
    }

    if ((this.hsState as string) === "META_BODY") {
      if (this.buf.length < this.metaLength) return; // wait for full metadata block
      logger.debug({ metaLength: this.metaLength }, "Databento Live: metadata consumed");
      this.buf = this.buf.subarray(this.metaLength);
      this.hsState = "RECORDS";
    }

    // Record parsing state
    if ((this.hsState as string) === "RECORDS") {
      this.parseRecords();
    }
  }

  // ---------------------------------------------------------------------------
  // Text handshake
  // ---------------------------------------------------------------------------

  private handleTextLine(line: string): void {
    const msg = parseGateway(line);
    logger.debug({ state: this.hsState, line }, "Databento Live: gateway message");

    if (this.hsState === "GREETING") {
      // Line 1: lsg_version=<ver>
      // No action needed beyond logging — wait for the challenge on the next line.
      logger.info({ lsg_version: msg.lsg_version }, "Databento Live: gateway greeting");
      this.hsState = "CHALLENGE";

    } else if (this.hsState === "CHALLENGE") {
      // Line 2: cram=<challenge>
      const challenge = msg.cram;
      if (!challenge) {
        logger.error({ msg }, "Databento Live: expected cram= field");
        this.socket?.destroy();
        return;
      }

      // Send AuthenticationRequest (pipe-delimited, NOT JSON)
      const response = cramResponse(challenge, this.apiKey);
      this.socket!.write(
        gatewayMsg({
          auth: response,
          dataset: this.dataset,
          encoding: "dbn",
          ts_out: "0",
          heartbeat_interval_s: 30,
          client: "databento-node/1.0",
        }),
      );
      this.hsState = "AUTH_SENT";

    } else if (this.hsState === "AUTH_SENT") {
      // Line 3: success=1|session_id=... OR success=0|error=...
      if (msg.success !== "1") {
        logger.error({ msg }, "Databento Live: authentication rejected");
        this.socket?.destroy();
        return;
      }

      logger.info({ session_id: msg.session_id }, "Databento Live: authenticated");

      // Send SubscriptionRequest — all currently active symbols in one message.
      // activeSymbols includes the constructor set plus any symbols added via
      // subscribeLiveSymbol() before or during the handshake.
      this.socket!.write(
        gatewayMsg({
          schema: "ohlcv-1m",
          stype_in: "continuous",
          symbols: [...this.activeSymbols].join(","),
          snapshot: "0",
          is_last: "1",
        }),
      );

      // Send SessionStart (pipe-delimited, NOT JSON `action: start`)
      this.socket!.write(gatewayMsg({ start_session: "0" }));

      // Switch to binary mode: first expect DBN metadata block
      this.hsState = "META_INIT";
      this.reconnectDelayMs = 5_000; // reset backoff on successful auth
      this.emit("connected");
      logger.info({ symbols: [...this.activeSymbols] }, "Databento Live: session started — streaming");
    }
  }

  // ---------------------------------------------------------------------------
  // DBN record parser
  // ---------------------------------------------------------------------------

  private parseRecords(): void {
    while (this.buf.length >= 2) {
      const lengthField = this.buf.readUInt8(0);

      if (lengthField === 0) {
        // Corrupt stream — skip one byte and attempt to resync
        logger.warn("Databento Live: zero-length record field, resyncing");
        this.buf = this.buf.subarray(1);
        continue;
      }

      const recordBytes = lengthField * 4;

      if (this.buf.length < recordBytes) break; // wait for more data

      const record = this.buf.subarray(0, recordBytes);
      this.buf = this.buf.subarray(recordBytes);

      const rtype = record.readUInt8(1);

      if (rtype === RTYPE_OHLCV_1M) {
        this.handleOhlcv(record);
      } else if (rtype === RTYPE_SYMBOL_MAP) {
        this.handleSymbolMapping(record);
      } else if (rtype === RTYPE_SYSTEM) {
        // Heartbeat / non-error system message — no action needed
        logger.debug({ recordBytes }, "Databento Live: system/heartbeat message");
      } else if (rtype === RTYPE_ERROR) {
        // Gateway error message — log the payload as a string for debugging
        const errMsg = record.subarray(16).toString("utf8").replace(/\0+$/, "").trim();
        logger.warn({ errMsg }, "Databento Live: gateway error record");
      } else {
        logger.debug(
          { rtype: `0x${rtype.toString(16)}`, recordBytes },
          "Databento Live: unhandled record type — skipping",
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Record handlers
  // ---------------------------------------------------------------------------

  private handleSymbolMapping(record: Buffer): void {
    // SymbolMappingMsg layout (SYMBOL_CSTR_LEN=22, total 80 bytes, length_field=20):
    //   bytes 0-15:  RecordHeader (hd)
    //   byte  16:    stype_in  (u8 SType enum)
    //   bytes 17-38: stype_in_symbol  (char[22], null-padded)
    //   byte  39:    stype_out (u8 SType enum)
    //   bytes 40-61: stype_out_symbol (char[22], null-padded)
    //   bytes 62-63: padding (C struct alignment for uint64)
    //   bytes 64-71: start_ts (uint64 LE)
    //   bytes 72-79: end_ts   (uint64 LE)
    if (record.length < 80) return;

    const instrumentId = record.readUInt32LE(4);
    // byte 16: stype_in enum; bytes 17-38: stype_in_symbol (22 bytes, null-padded)
    // When stype_in=continuous, stype_in_symbol is our subscribed symbol (e.g. "ES.v.0")
    const stypeIn = record.subarray(17, 39).toString("utf8").replace(/\0+$/, "").trim();

    const matched = this.activeSymbols.has(stypeIn) ? stypeIn : undefined;
    const mapTo = matched ?? stypeIn;
    this.instrumentMap.set(instrumentId, mapTo);

    logger.debug({ instrumentId, stypeIn, mapTo }, "Databento Live: symbol mapped");
  }

  private handleOhlcv(record: Buffer): void {
    if (record.length < 56) return; // OhlcvMsg must be 56 bytes

    const instrumentId = record.readUInt32LE(4);

    // ts_event: nanoseconds since epoch (uint64 LE)
    const tsNs = record.readBigUInt64LE(8);
    const tsMs = Number(tsNs) / 1e6;

    // Prices are int64 fixed-point scaled by 1e9
    const open   = Number(record.readBigInt64LE(16)) / 1e9;
    const high   = Number(record.readBigInt64LE(24)) / 1e9;
    const low    = Number(record.readBigInt64LE(32)) / 1e9;
    const close  = Number(record.readBigInt64LE(40)) / 1e9;
    const volume = Number(record.readBigUInt64LE(48));

    if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || !Number.isFinite(volume)) return;

    const symbol = this.instrumentMap.get(instrumentId);
    if (!symbol) {
      logger.debug({ instrumentId }, "Databento Live: OHLCV for unmapped instrument — skipping");
      return;
    }

    const bar: OhlcvBar = { symbol, ts: tsMs, open, high, low, close, volume };
    logger.debug({ symbol, close, volume }, "Databento Live: bar received");
    this.emit("bar", bar);
  }
}
