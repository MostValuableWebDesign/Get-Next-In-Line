import { useEffect, useState } from "react";
import { useLocation } from "wouter";

export type AuthState = "loading" | "authenticated" | "unauthenticated";

export type NetworkRole = "super_admin" | "district_manager" | "merchant" | "staff";

// Module-level cache so any component can read the session role without an
// extra request (populated by the useAuth check that gates the whole app).
let cachedRole: NetworkRole | null = null;
const roleListeners = new Set<(role: NetworkRole | null) => void>();

function setCachedRole(role: NetworkRole | null) {
  cachedRole = role;
  roleListeners.forEach((l) => l(role));
}

/** The session's governance role (null until /api/auth/me resolves). */
export function useSessionRole(): NetworkRole | null {
  const [role, setRole] = useState<NetworkRole | null>(cachedRole);
  useEffect(() => {
    const listener = (r: NetworkRole | null) => setRole(r);
    roleListeners.add(listener);
    return () => {
      roleListeners.delete(listener);
    };
  }, []);
  return role;
}

/**
 * Checks session auth state via GET /api/auth/me.
 * Redirects to /login when unauthenticated.
 */
export function useAuth(): { authState: AuthState } {
  const [authState, setAuthState] = useState<AuthState>("loading");
  const [, setLocation] = useLocation();

  useEffect(() => {
    let cancelled = false;

    fetch("/api/auth/me", { credentials: "include" })
      .then(async (res) => {
        if (cancelled) return;
        if (res.ok) {
          try {
            const body = (await res.json()) as { role?: NetworkRole };
            setCachedRole(body.role ?? "super_admin");
          } catch {
            setCachedRole("super_admin");
          }
          setAuthState("authenticated");
        } else {
          setCachedRole(null);
          setAuthState("unauthenticated");
          setLocation("/login");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAuthState("unauthenticated");
          setLocation("/login");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [setLocation]);

  return { authState };
}
