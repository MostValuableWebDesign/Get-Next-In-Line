/**
 * Login page connection-state behavior:
 *  - offline → submit button disabled with an offline hint;
 *  - online → normal submit, successful login navigates home;
 *  - fetch failure → connectivity error message, distinct from the
 *    wrong-password error returned by the server.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import Login from '@/pages/Login';

const isOfflineMock = vi.fn(() => false);
vi.mock('@/hooks/use-online', () => ({
  useIsOffline: () => isOfflineMock(),
}));

function renderLogin() {
  const { hook, history } = memoryLocation({ path: '/login', record: true });
  render(
    <Router hook={hook}>
      <Login />
    </Router>,
  );
  return { history };
}

function fillPassword(value = 'hunter2') {
  fireEvent.change(screen.getByLabelText(/admin password/i), {
    target: { value },
  });
}

beforeEach(() => {
  isOfflineMock.mockReturnValue(false);
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Login — offline state', () => {
  it('disables submit and shows the offline hint', () => {
    isOfflineMock.mockReturnValue(true);
    renderLogin();
    fillPassword();

    expect(screen.getByText(/you're offline/i)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: /offline/i });
    expect(button).toBeDisabled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Login — online state', () => {
  it('enables submit once a password is entered and logs in normally', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    const { history } = renderLogin();

    const button = screen.getByRole('button', { name: /^sign in$/i });
    expect(button).toBeDisabled(); // empty password
    fillPassword();
    expect(button).toBeEnabled();
    expect(screen.queryByText(/you're offline/i)).not.toBeInTheDocument();

    fireEvent.click(button);
    await waitFor(() => expect(history).toContain('/'));
    expect(fetch).toHaveBeenCalledWith(
      '/api/auth/login',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('shows the server error for wrong passwords', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Invalid credentials. Try again.' }),
    });
    renderLogin();
    fillPassword('wrong');
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(
      await screen.findByText(/invalid credentials/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/could not reach the server/i),
    ).not.toBeInTheDocument();
  });
});

describe('Login — fetch failure', () => {
  it('shows a connectivity error distinct from wrong-password', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new TypeError('Failed to fetch'),
    );
    renderLogin();
    fillPassword();
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(
      await screen.findByText(/could not reach the server/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/invalid credentials/i),
    ).not.toBeInTheDocument();
  });
});
