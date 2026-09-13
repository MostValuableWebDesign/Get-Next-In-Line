import { ReactNode } from "react";
import { Redirect } from "wouter";
import { useAuth, useSessionRole } from "@/hooks/useAuth";

export function PlatformRouteGuard({ children }: { children: ReactNode }) {
  const { authState } = useAuth();
  const role = useSessionRole();

  if (authState === "loading") {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-zinc-400 font-mono uppercase tracking-widest">Securing Platform</p>
        </div>
      </div>
    );
  }

  if (authState === "unauthenticated") {
    // Let useAuth handle redirect to login
    return null;
  }

  if (role !== "super_admin") {
    // Authenticated but not a super admin
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-6 text-zinc-200">
        <div className="max-w-md w-full bg-zinc-900 border border-zinc-800 rounded-xl p-8 text-center shadow-2xl">
          <div className="size-12 rounded-full bg-red-500/10 text-red-500 flex items-center justify-center mx-auto mb-4">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/></svg>
          </div>
          <h1 className="text-2xl font-semibold text-white mb-2 tracking-tight">Access Denied</h1>
          <p className="text-zinc-400 mb-6 text-sm">
            This area is restricted to GNIL Platform Administrators. Your current role ({role}) does not grant access to the platform control plane.
          </p>
          <a
            href="/"
            className="inline-flex items-center justify-center h-10 px-6 rounded-md bg-zinc-800 hover:bg-zinc-700 text-white text-sm font-medium transition-colors"
          >
            Return to Business Console
          </a>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
