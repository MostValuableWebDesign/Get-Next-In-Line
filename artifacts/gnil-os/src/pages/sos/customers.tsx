import React, { useState } from 'react';
import { 
  useListSosCustomers, useCreateSosCustomer,
  getListSosCustomersQueryKey
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search, Plus, Phone, Mail, MessageSquare } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';

export function CustomersPage() {
  const [search, setSearch] = useState('');
  const { data: customers } = useListSosCustomers({ search: search || undefined });

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Customers</h1>
          <p className="text-muted-foreground text-sm mt-1">Manage client records and preferences.</p>
        </div>
        <AddCustomerDialog />
      </div>

      <Card>
        <CardHeader className="py-4">
          <div className="relative w-72">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input 
              placeholder="Search customers..." 
              className="pl-9" 
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </CardHeader>
        <div className="border-t">
          <table className="w-full text-sm text-left">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Name</th>
                <th className="px-6 py-3 font-medium">Contact</th>
                <th className="px-6 py-3 font-medium">Marketing</th>
                <th className="px-6 py-3 font-medium">Visits</th>
                <th className="px-6 py-3 font-medium">Last Visit</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {customers?.map(c => (
                <tr key={c.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-6 py-4 font-medium">{c.name}</td>
                  <td className="px-6 py-4 text-muted-foreground">
                    {c.phone && <div className="flex items-center gap-1.5"><Phone className="w-3 h-3"/> {c.phone}</div>}
                    {c.email && <div className="flex items-center gap-1.5 mt-1"><Mail className="w-3 h-3"/> {c.email}</div>}
                    {!c.phone && !c.email && '-'}
                  </td>
                  <td className="px-6 py-4">
                    {c.smsOptIn ? (
                      <span className="inline-flex items-center gap-1.5 text-emerald-600 bg-emerald-50 px-2 py-1 rounded text-xs font-medium border border-emerald-200">
                        <MessageSquare className="w-3 h-3" /> SMS Subscribed
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-xs">Opted out</span>
                    )}
                  </td>
                  <td className="px-6 py-4">{c.visitCount}</td>
                  <td className="px-6 py-4 text-muted-foreground">
                    {c.lastVisitAt ? new Date(c.lastVisitAt).toLocaleDateString() : 'Never'}
                  </td>
                </tr>
              ))}
              {customers?.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-muted-foreground">
                    No customers found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function AddCustomerDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [smsOptIn, setSmsOptIn] = useState(true);

  const create = useCreateSosCustomer();
  const queryClient = useQueryClient();

  const handleSave = () => {
    create.mutate(
      { data: { name, phone, email, smsOptIn } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListSosCustomersQueryKey() });
          setOpen(false);
        }
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button><Plus className="mr-2 h-4 w-4" /> Add Customer</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add New Customer</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Full Name *</Label>
            <Input value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Phone Number</Label>
            <Input value={phone} onChange={e => setPhone(e.target.value)} type="tel" />
          </div>
          <div className="space-y-2">
            <Label>Email</Label>
            <Input value={email} onChange={e => setEmail(e.target.value)} type="email" />
          </div>
          <div className="flex items-center space-x-2 pt-2">
            <Checkbox 
              id="sms" 
              checked={smsOptIn} 
              onCheckedChange={(c) => setSmsOptIn(c as boolean)} 
            />
            <Label htmlFor="sms" className="text-sm font-normal">
              Opt-in to SMS waitlist and appointment notifications
            </Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={!name}>Save Customer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
