import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const AUTH_TOKEN_KEY = 'auth_session_token';
const IS_WEB = Platform.OS === 'web';

interface User {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
}

interface AuthContextValue {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (password: string) => Promise<boolean>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  isLoading: true,
  isAuthenticated: false,
  login: async () => false,
  logout: async () => {},
});

function getApiBaseUrl(): string {
  if (process.env.EXPO_PUBLIC_DOMAIN) {
    return `https://${process.env.EXPO_PUBLIC_DOMAIN}`;
  }
  return '';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchUser = useCallback(async () => {
    try {
      if (IS_WEB) {
        // On web, the session cookie is sent automatically
        const res = await fetch('/api/auth/user', { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { user?: User };
        setUser(data.user ?? null);
      } else {
        // On native, send the stored Bearer token
        const token = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
        if (!token) {
          setUser(null);
          return;
        }
        const apiBase = getApiBaseUrl();
        const res = await fetch(`${apiBase}/api/auth/user`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = (await res.json()) as { user?: User };
        if (data.user) {
          setUser(data.user);
        } else {
          await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
          setUser(null);
        }
      }
    } catch {
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchUser();
  }, [fetchUser]);

  const login = useCallback(
    async (password: string): Promise<boolean> => {
      try {
        if (IS_WEB) {
          // On web, use cookie-based session (same as the web app)
          const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ password }),
          });
          if (!res.ok) return false;
          await fetchUser();
          return true;
        } else {
          // On native, get a Bearer token and store it in SecureStore
          const apiBase = getApiBaseUrl();
          if (!apiBase) {
            console.error('EXPO_PUBLIC_DOMAIN is not configured.');
            return false;
          }
          const res = await fetch(`${apiBase}/api/mobile-auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password }),
          });
          if (!res.ok) return false;
          const data = (await res.json()) as { token?: string };
          if (!data.token) return false;
          await SecureStore.setItemAsync(AUTH_TOKEN_KEY, data.token);
          await fetchUser();
          return true;
        }
      } catch (err) {
        console.error('Login error:', err);
        return false;
      }
    },
    [fetchUser],
  );

  const logout = useCallback(async () => {
    try {
      if (IS_WEB) {
        await fetch('/api/logout', { method: 'POST', credentials: 'include' });
      } else {
        const token = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
        if (token) {
          const apiBase = getApiBaseUrl();
          await fetch(`${apiBase}/api/mobile-auth/logout`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          });
        }
        await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
      }
    } catch {
      // ignore
    } finally {
      setUser(null);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, isLoading, isAuthenticated: !!user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
