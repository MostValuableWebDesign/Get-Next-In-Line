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

const hookCalls: Record<string, unknown[]> = { messages: [], customers: [], send: [] };

vi.mock('@workspace/api-client-react', () => ({
  useListSosMessages: (...args: unknown[]) => {
    hookCalls.messages.push(args);
    return { data: messages };
  },
  getListSosMessagesQueryKey: () => ['/api/sos/messages'],
  useSendSosMessage: (...args: unknown[]) => {
    hookCalls.send.push(args);
    return { mutate: sendMutate, isPending: false };
  },
  useListSosCustomers: (...args: unknown[]) => {
    hookCalls.customers.push(args);
    return { data: customers };
  },
  getListSosCustomersQueryKey: () => ['/api/sos/customers'],
}));

import { SmsConversations } from '../sms-conversations';

function renderIt(tenantId?: number) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SmsConversations tenantId={tenantId} />
    </QueryClientProvider>,
  );
}

describe('SmsConversations', () => {
  beforeEach(() => {
    sendMutate.mockClear();
    hookCalls.messages = [];
    hookCalls.customers = [];
    hookCalls.send = [];
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

  it('surfaces error details on failed outbound messages, leaves delivered ones unchanged', () => {
    messages = [
      msg({
        id: 6,
        customerId: 1,
        customerName: 'Ana',
        body: 'This one failed',
        deliveryStatus: 'failed',
        errorCode: '30003',
        errorMessage: 'Unreachable destination handset',
        createdAt: '2026-07-02T10:05:00Z',
      }),
      msg({ id: 5, customerId: 1, customerName: 'Ana', body: 'Delivered fine', deliveryStatus: 'delivered', createdAt: '2026-07-02T10:00:00Z' }),
    ];
    renderIt();
    fireEvent.click(screen.getByTestId('conversation-item-c:1'));

    const failedBubble = screen.getByTestId('message-bubble-6');
    expect(within(failedBubble).getByTestId('message-delivery-error-6')).toBeInTheDocument();
    expect(within(failedBubble).getByTestId('badge-message-status-6')).toHaveTextContent('failed');
    expect(failedBubble).toHaveTextContent('[30003] Unreachable destination handset');

    const okBubble = screen.getByTestId('message-bubble-5');
    expect(within(okBubble).queryByTestId('message-delivery-error-5')).not.toBeInTheDocument();
    expect(okBubble).toHaveTextContent('delivered');
  });

  it('surfaces skipped outbound messages with the error detail', () => {
    messages = [
      msg({
        id: 7,
        customerId: 1,
        customerName: 'Ana',
        body: 'Skipped one',
        deliveryStatus: 'skipped',
        errorCode: 'opted_out',
        errorMessage: 'Customer has opted out of SMS',
        createdAt: '2026-07-02T10:10:00Z',
      }),
    ];
    renderIt();
    const bubble = screen.getByTestId('message-bubble-7');
    expect(within(bubble).getByTestId('badge-message-status-7')).toHaveTextContent('skipped');
    expect(bubble).toHaveTextContent('[opted_out] Customer has opted out of SMS');
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

  it('scopes reads and replies to the tenant when tenantId is given', () => {
    renderIt(7);
    const tenantHeaders = { headers: { 'x-tenant-id': '7' } };

    const msgOpts = (hookCalls.messages[0] as unknown[])[1] as {
      query: { queryKey: unknown[] };
      request?: unknown;
    };
    expect(msgOpts.request).toEqual(tenantHeaders);
    expect(msgOpts.query.queryKey).toContainEqual({ tenantId: 7 });

    const custOpts = (hookCalls.customers[0] as unknown[])[1] as {
      query: { queryKey: unknown[] };
      request?: unknown;
    };
    expect(custOpts.request).toEqual(tenantHeaders);
    expect(custOpts.query.queryKey).toContainEqual({ tenantId: 7 });

    const sendOpts = (hookCalls.send[0] as unknown[])[0] as { request?: unknown };
    expect(sendOpts.request).toEqual(tenantHeaders);
  });

  it('stays unscoped (no tenant header) without a tenantId', () => {
    renderIt();
    const msgOpts = (hookCalls.messages[0] as unknown[])[1] as { request?: unknown };
    expect(msgOpts.request).toBeUndefined();
    const sendOpts = (hookCalls.send[0] as unknown[])[0] as { request?: unknown } | undefined;
    expect(sendOpts?.request).toBeUndefined();
  });
});
