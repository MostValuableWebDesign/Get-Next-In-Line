import React, { useState } from 'react';
import {
  useListSosCustomers, useCreateSosCustomer,
  getListSosCustomersQueryKey,
  type SosCustomer,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { useToast } from '@/hooks/use-toast';
import { Check, ChevronsUpDown, Phone, UserPlus, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Shared searchable customer picker used by every staff dialog that needs a
 * customer (walk-in check-in, quick book). Searches the SOS customers API by
 * name/phone server-side, and lets staff quick-create a customer inline when
 * no match is found.
 */
export function CustomerPicker({
  value,
  onChange,
  placeholder = 'Search customer by name or phone…',
}: {
  value: SosCustomer | null;
  onChange: (customer: SosCustomer | null) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  // Server-side search (same API the customer list uses); Command's own
  // client-side filtering is disabled so results match the server exactly.
  const { data: customers, isLoading } = useListSosCustomers(
    { search: search || undefined },
    { query: { queryKey: getListSosCustomersQueryKey({ search: search || undefined }) } },
  );

  const createCustomer = useCreateSosCustomer();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const trimmed = search.trim();

  const handleQuickCreate = () => {
    createCustomer.mutate(
      { data: { name: trimmed, smsOptIn: true } },
      {
        onSuccess: (created) => {
          queryClient.invalidateQueries({ queryKey: getListSosCustomersQueryKey() });
          onChange(created);
          setOpen(false);
          setSearch('');
          toast({ title: 'Customer created', description: `${created.name} added.` });
        },
        onError: () => {
          toast({ title: "Couldn't create customer", description: 'Please try again.', variant: 'destructive' });
        },
      },
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
          data-testid="button-customer-picker"
        >
          {value ? (
            <span className="truncate">
              {value.name}
              {value.phone ? <span className="text-muted-foreground ml-2 text-xs">{value.phone}</span> : null}
            </span>
          ) : (
            <span className="text-muted-foreground">Select customer…</span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={placeholder}
            value={search}
            onValueChange={setSearch}
            data-testid="input-customer-search"
          />
          <CommandList>
            {isLoading ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin inline mr-2" /> Searching…
              </div>
            ) : (
              <>
                <CommandEmpty>No customers found.</CommandEmpty>
                <CommandGroup>
                  {customers?.map((c) => (
                    <CommandItem
                      key={c.id}
                      value={String(c.id)}
                      onSelect={() => {
                        onChange(c);
                        setOpen(false);
                      }}
                      data-testid={`option-customer-${c.id}`}
                    >
                      <Check className={cn('mr-2 h-4 w-4', value?.id === c.id ? 'opacity-100' : 'opacity-0')} />
                      <span className="truncate">{c.name}</span>
                      {c.phone && (
                        <span className="ml-auto text-xs text-muted-foreground flex items-center gap-1 shrink-0 pl-2">
                          <Phone className="h-3 w-3" /> {c.phone}
                        </span>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
                {trimmed.length > 1 && (
                  <CommandGroup>
                    <CommandItem
                      value={`__create__${trimmed}`}
                      onSelect={handleQuickCreate}
                      disabled={createCustomer.isPending}
                      data-testid="option-create-customer"
                    >
                      <UserPlus className="mr-2 h-4 w-4" />
                      Create customer "{trimmed}"
                    </CommandItem>
                  </CommandGroup>
                )}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
