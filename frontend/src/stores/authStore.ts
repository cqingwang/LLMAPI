import { create } from 'zustand';

export const ACCESS_TOKEN = 'axonhub_access_token';
export const BROWSER_SESSION_COOKIE = 'axonhub_browser_session';
const USER_INFO = 'axonhub_user_info';

interface Role {
  code: string;
  name: string;
}

interface Project {
  projectID: string;
  isOwner: boolean;
  scopes: string[];
  effectiveScopes?: string[];
  roles: Role[];
}

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  isOwner: boolean;
  preferLanguage: string;
  avatar?: string;
  scopes: string[];
  roles: Role[];
  projects: Project[];
  oidcIdentities?: { id: string; idpName: string; issuer: string; subject: string; email: string }[];
  hasPassword?: boolean;
}

interface AuthState {
  auth: {
    user: AuthUser | null;
    setUser: (user: AuthUser | null) => void;
    accessToken: string;
    setAccessToken: (accessToken: string) => void;
    resetAccessToken: () => void;
    reset: () => void;
  };
}

// Helper functions for localStorage
export const getTokenFromStorage = (): string => {
  try {
    return localStorage.getItem(ACCESS_TOKEN) || '';
    } catch (error) {
      return '';
    }
  };

export const setTokenToStorage = (token: string): void => {
  try {
    localStorage.setItem(ACCESS_TOKEN, token);
    if (typeof document !== 'undefined') {
      document.cookie = `${BROWSER_SESSION_COOKIE}=${encodeURIComponent(token)}; path=/; SameSite=Lax`;
    }
  } catch (error) {
  }
};

export const restoreTokenFromSessionURL = (): void => {
  if (typeof window === 'undefined') return;

  const sessionId = new URL(window.location.href).searchParams.get('sessionid');
  if (!sessionId) return;

  setTokenToStorage(sessionId);
  useAuthStore.getState().auth.setAccessToken(sessionId);
};

export const markBrowserSession = (): void => {
  if (typeof document === 'undefined') return;

  const token = getTokenFromStorage();
  if (!token) return;

  document.cookie = `${BROWSER_SESSION_COOKIE}=${encodeURIComponent(token)}; path=/; SameSite=Lax`;
};

export const ensureSessionIdInURL = (): void => {
  if (typeof window === 'undefined') return;

  const token = getTokenFromStorage();
  if (!token) return;

  const url = new URL(window.location.href);
  if (url.searchParams.get('sessionid') === token) return;

  url.searchParams.set('sessionid', token);
  window.history.replaceState(window.history.state, '', url);
};

export const removeTokenFromStorage = (): void => {
  try {
    localStorage.removeItem(ACCESS_TOKEN);
    if (typeof document !== 'undefined') {
      document.cookie = `${BROWSER_SESSION_COOKIE}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`;
    }
  } catch (error) {
  }
};

const getUserFromStorage = (): AuthUser | null => {
  try {
    const userStr = localStorage.getItem(USER_INFO);
    return userStr ? JSON.parse(userStr) : null;
  } catch (error) {
    return null;
  }
};

const setUserToStorage = (user: AuthUser | null): void => {
  try {
    if (user) {
      localStorage.setItem(USER_INFO, JSON.stringify(user));
    } else {
      localStorage.removeItem(USER_INFO);
    }
  } catch (error) {
  }
};

const removeUserFromStorage = (): void => {
  try {
    localStorage.removeItem(USER_INFO);
  } catch (error) {
  }
};

export const useAuthStore = create<AuthState>()((set) => {
  const initToken = getTokenFromStorage();
  const initUser = getUserFromStorage();

  return {
    auth: {
      user: initUser,
      setUser: (user) =>
        set((state) => {
          setUserToStorage(user);
          return { ...state, auth: { ...state.auth, user } };
        }),
      accessToken: initToken,
      setAccessToken: (accessToken) =>
        set((state) => {
          setTokenToStorage(accessToken);
          return { ...state, auth: { ...state.auth, accessToken } };
        }),
      resetAccessToken: () =>
        set((state) => {
          removeTokenFromStorage();
          return { ...state, auth: { ...state.auth, accessToken: '' } };
        }),
      reset: () =>
        set((state) => {
          removeTokenFromStorage();
          removeUserFromStorage();
          return {
            ...state,
            auth: { ...state.auth, user: null, accessToken: '' },
          };
        }),
    },
  };
});

// export const useAuth = () => useAuthStore((state) => state.auth)
