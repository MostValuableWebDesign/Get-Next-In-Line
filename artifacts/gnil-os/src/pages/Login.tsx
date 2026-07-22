import { useState, FormEvent } from "react";
import { useLocation } from "wouter";
import { useIsOffline } from "@/hooks/use-online";

export default function Login() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [, setLocation] = useLocation();
  const isOffline = useIsOffline();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        setLocation("/");
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Invalid credentials. Try again.");
      }
    } catch {
      setError("Could not reach the server. Check your connection.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[hsl(210,20%,98%)] flex items-center justify-center">
      <div className="w-full max-w-sm">
        {/* Logo / brand */}
        <div className="mb-8 text-center">
          <div className="inline-flex items-center mb-3">
            <div className="rounded-md bg-indigo-600 px-4 py-2">
              <span className="text-white font-bold text-lg tracking-tight">GNIL Operator Terminal</span>
            </div>
          </div>
        </div>

        {/* Login card */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-8">
          <h1 className="text-slate-900 font-semibold text-lg mb-1">Sign in</h1>
          <p className="text-slate-500 text-sm mb-6">
            Enter your admin password to access the command center.
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="password"
                className="block text-xs font-medium text-slate-600 mb-1.5 uppercase tracking-wide"
              >
                Admin Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition"
              />
            </div>

            {isOffline && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 px-3.5 py-2.5 text-sm text-amber-700">
                You're offline — the server can't be reached right now. Sign-in
                is disabled until the connection is restored.
              </div>
            )}

            {error && (
              <div className="rounded-lg bg-red-50 border border-red-100 px-3.5 py-2.5 text-sm text-red-600">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !password || isOffline}
              className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium py-2.5 transition-colors"
            >
              {loading ? "Signing in…" : isOffline ? "Offline — can’t sign in" : "Sign in"}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-slate-400 mt-6">
          GNIL Operator Terminal · Agency OS
        </p>
      </div>
    </div>
  );
}
