import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const sendMutate = vi.fn();

const msg = (over: Partial<Record<string, unknown>>) => ({
  id: 0,
  customerId: null,
  customerName: null,
  toNumber: null,
  direction: 'outbound',
  body: '',
  kind: 'manual',
  deliveryStatus: 'simulated',
  providerSid: null,
  errorCode: null,
  errorMessage: null,
  createdAt: '2026-07-01T10:00:00Z',
  ...over,
});

// Newest first, like the API.
let messages: ReturnType<typeof msg>[] = [];
let customers: Array<{ id: number; name: string; smsOptIn: boolean }> = [];

vi.mock('@workspace/api-client-react', () => ({
  useListSosMessages: () => ({ data: messages }),
  getListSosMessagesQueryKey: () => ['/api/sos/messages'],
  useSendSosMessage: () => ({ mutate: sendMutate, isPending: false }),
  useListSosCustomers: () => ({ data: customers }),
  getListSosCustomersQueryKey: () => ['/api/sos/customers'],
}));

import { SmsConversations } from '../sms-conversations';

function renderIt() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SmsConversations />
    </QueryClientProvider>,
  );
}

describe('SmsConversations', () => {
  beforeEach(() => {
    sendMutate.mockClear();
    customers = [
      { id: 1, name: 'Ana', smsOptIn: true },
      { id: 2, name: 'Bob', smsOptIn: false },
    ];
    messages = [
      msg({ id: 4, customerId: 2, customerName: 'Bob', body: 'STOP', direction: 'inbound', kind: 'inbound', createdAt: '2026-07-02T12:00:00Z' }),
      msg({ id: 3, customerId: 1, customerName: 'Ana', body: 'Yes please', direction: 'inbound', kind: 'inbound', createdAt: '2026-07-02T11:00:00Z' }),
      msg({ id: 2, customerId: 1, customerName: 'Ana', body: 'Your slot is open', createdAt: '2026-07-02T10:00:00Z' }),
      msg({ id: 1, customerId: null, toNumber: '+15550009999', body: 'Hi?', direction: 'inbound', kind: 'inbound', createdAt: '2026-07-01T09:00:00Z' }),
    ];
  });

  it('groups messages into per-customer threads, newest thread first', () => {
    renderIt();
    const list = screen.getByTestId('conversation-list');
    const items = within(list).getAllByRole('button');
    expect(items[0]).toHaveTextContent('Bob');
    expect(items[1]).toHaveTextContent('Ana');
    expect(items[2]).toHaveTextContent('+15550009999');
  });

  it('shows a thread with inbound and outbound bubbles distinct and sends a reply', () => {
    renderIt();
    fireEvent.click(screen.getByTestId('conversation-item-c:1'));
    expect(screen.getByTestId('message-bubble-2')).toHaveAttribute('data-direction', 'outbound');
    expect(screen.getByTestId('message-bubble-3')).toHaveAttribute('data-direction', 'inbound');

    fireEvent.change(screen.getByTestId('input-reply'), { target: { value: 'See you at 2!' } });
    fireEvent.click(screen.getByTestId('button-send-reply'));
    expect(sendMutate).toHaveBeenCalledTimes(1);
    expect(sendMutate.mock.calls[0][0]).toEqual({
      data: { customerId: 1, body: 'See you at 2!', kind: 'manual' },
    });
  });

  it('disables replies for opted-out customers', () => {
    renderIt();
    fireEvent.click(screen.getByTestId('conversation-item-c:2'));
    expect(screen.getByTestId('badge-opted-out')).toBeInTheDocument();
    expect(screen.getByTestId('text-opted-out')).toBeInTheDocument();
    expect(screen.queryByTestId('input-reply')).not.toBeInTheDocument();
  });

  it('offers no reply box for numbers not linked to a customer', () => {
    renderIt();
    fireEvent.click(screen.getByTestId('conversation-item-p:+15550009999'));
    expect(screen.getByTestId('text-no-reply')).toBeInTheDocument();
    expect(screen.queryByTestId('input-reply')).not.toBeInTheDocument();
  });
});
