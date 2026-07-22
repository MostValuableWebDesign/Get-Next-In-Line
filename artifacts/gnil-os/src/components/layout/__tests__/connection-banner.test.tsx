/**
 * Guards the app-level connection-lost banner rendered by Shell.
 *
 * The health check (via @workspace/api-client-react's useHealthCheck) is
 * mocked so the test exercises both Shell and the shared use-online hook:
 *  - the banner appears when the API is offline,
 *  - it clears when the health check recovers,
 *  - and dismissing it resets after recovery so a future outage shows it again.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Shell } from '@/components/layout/Shell';

type HealthState = {
  data: { status: string } | undefined;
  isError: boolean;
  isFetched: boolean;
};

const healthState: HealthState = { data: undefined, isError: false, isFetched: false };

vi.mock('@workspace/api-client-react', () => ({
  useHealthCheck: () => ({ ...healthState }),
  getHealthCheckQueryKey: () => ['health'],
}));

function setOnline() {
  healthState.data = { status: 'ok' };
  healthState.isError = false;
  healthState.isFetched = true;
}

function setOffline() {
  healthState.data = undefined;
  healthState.isError = true;
  healthState.isFetched = true;
}

const BANNER_TEXT = /connection lost/i;

function renderShell() {
  return render(
    <Shell>
      <div data-testid="page-content">content</div>
    </Shell>,
  );
}

describe('Shell connection-lost banner', () => {
  beforeEach(() => {
    healthState.data = undefined;
    healthState.isError = false;
    healthState.isFetched = false;
  });

  it('does not show the banner before the health check settles', () => {
    renderShell();
    expect(screen.queryByText(BANNER_TEXT)).not.toBeInTheDocument();
  });

  it('shows the banner when the health check reports offline', () => {
    setOffline();
    renderShell();
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent(BANNER_TEXT);
  });

  it('does not show the banner while online', () => {
    setOnline();
    renderShell();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears the banner when the connection recovers', () => {
    setOffline();
    const { rerender } = renderShell();
    expect(screen.getByRole('alert')).toBeInTheDocument();

    setOnline();
    rerender(
      <Shell>
        <div data-testid="page-content">content</div>
      </Shell>,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('resets dismissal after recovery so the next outage shows the banner again', () => {
    setOffline();
    const { rerender } = renderShell();

    fireEvent.click(screen.getByRole('button', { name: /dismiss connection notice/i }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // Recover…
    setOnline();
    rerender(
      <Shell>
        <div>content</div>
      </Shell>,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // …then drop again: the banner must reappear despite the earlier dismissal.
    setOffline();
    rerender(
      <Shell>
        <div>content</div>
      </Shell>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(BANNER_TEXT);
  });
});
