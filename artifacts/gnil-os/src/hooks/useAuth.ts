import { useEffect, useState } from "react";
import { useLocation } from "wouter";

export type AuthState = "loading" | "authenticated" | "unauthenticated";

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
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setAuthState("authenticated");
        } else {
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
