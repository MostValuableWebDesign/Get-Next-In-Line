import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListOperationsWorkforceQueryKey,
  getListOperationsCompensationQueryKey,
  useLinkOperationsWorkforcePerson,
  useListOperationsWorkforce,
  useListOperationsCompensation,
  useListSosStaff,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSessionRole } from "@/hooks/useAuth";

type Filter = "all" | "linked" | "unlinked" | "active" | "inactive";

import { formatMoneyExact } from "@/lib/formatMoneyExact";

export function WorkforceStatePage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);
  const workforce = useListOperationsWorkforce();
  const staff = useListSosStaff();

  const role = useSessionRole();
  const isPrivileged = role === "super_admin" || role === "district_manager" || role === "merchant";

  const comp = useListOperationsCompensation({
    query: {
      enabled: isPrivileged,
      queryKey: getListOperationsCompensationQueryKey(),
    }
  });

  const link = useLinkOperationsWorkforcePerson({
    mutation: {
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: getListOperationsWorkforceQueryKey() }),
      onError: (value) =>
        setError(value instanceof Error ? value.message : "Unable to update workforce link"),
    },
  });

  const rows = useMemo(
    () =>
      (workforce.data ?? []).filter((person) => {
        if (filter === "linked") return person.linked;
        if (filter === "unlinked") return !person.linked;
        if (filter === "active") return person.employmentStatus === "active";
        if (filter === "inactive") return person.employmentStatus !== "active";
        return true;
      }),
    [filter, workforce.data],
  );

  if (workforce.isLoading || (isPrivileged && comp.isLoading)) {
    return <Skeleton className="h-72 rounded-xl" />;
  }

  if (workforce.isError) {
    return <div className="rounded-xl border border-destructive/30 p-6 text-destructive">Unable to load workforce records.</div>;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Staff & Workforce</h2>
          <p className="text-sm text-muted-foreground">
            Read-only provider records. Linking does not change GNIL bookings, availability, compensation, or chair assignments.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {(["all", "linked", "unlinked", "active", "inactive"] as Filter[]).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={filter === value ? "default" : "outline"}
              onClick={() => setFilter(value)}
            >
              {value[0].toUpperCase() + value.slice(1)}
            </Button>
          ))}
        </div>
      </div>
      {error && <div className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{error}</div>}
      {isPrivileged && comp.isError && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
          Unable to load compensation data. Compensation column will be hidden or incomplete.
        </div>
      )}
      {!rows.length ? (
        <div className="rounded-xl border border-dashed p-10 text-center text-muted-foreground">
          No workforce records match this filter. Connect Gusto, assign it the Employees capability, and run Sync now.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Person</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Role</th>
                {isPrivileged && <th className="px-4 py-3">Compensation</th>}
                <th className="px-4 py-3">Provider</th>
                <th className="px-4 py-3">GNIL link</th>
                <th className="px-4 py-3">Last synced</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((person) => {
                const personComp = comp.data?.find((c) => c.workforcePersonId === person.id);
                return (
                  <tr key={person.id}>
                    <td className="px-4 py-3">
                      <div className="font-medium">{person.displayName}</div>
                      <div className="text-xs text-muted-foreground">{person.email ?? person.personType}</div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={person.employmentStatus === "active" ? "default" : "secondary"}>
                        {person.employmentStatus}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">{person.jobTitle ?? "—"}</td>
                    {isPrivileged && (
                      <td className="px-4 py-3">
                        {personComp ? (
                          <div>
                            <div className="font-medium text-foreground">
                              {formatMoneyExact(personComp.amountCents, personComp.currency)} / {personComp.interval}
                            </div>
                            {(personComp.effectiveFrom || personComp.effectiveTo) && (
                              <div className="text-[10px] text-muted-foreground uppercase mt-0.5 tracking-wider">
                                {personComp.effectiveFrom && new Date(personComp.effectiveFrom).toLocaleDateString()}
                                {personComp.effectiveFrom && personComp.effectiveTo ? ' – ' : ''}
                                {personComp.effectiveTo && new Date(personComp.effectiveTo).toLocaleDateString()}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground italic text-xs">No data</span>
                        )}
                      </td>
                    )}
                    <td className="px-4 py-3 capitalize">{person.providerId}</td>
                    <td className="px-4 py-3">
                      <select
                        aria-label={`GNIL link for ${person.displayName}`}
                        className="h-9 min-w-44 rounded-md border bg-background px-2"
                        value={person.gnilStaffId == null ? "" : String(person.gnilStaffId)}
                        disabled={link.isPending || staff.isLoading}
                        onChange={(event) => {
                          setError(null);
                          link.mutate({
                            personId: person.id,
                            data: { staffId: event.target.value ? Number(event.target.value) : null },
                          });
                        }}
                      >
                        <option value="">Unlinked</option>
                        {(staff.data ?? []).map((member) => (
                          <option key={member.id} value={member.id}>{member.name}</option>
                        ))}
                      </select>
                      {person.linkType && (
                        <div className="mt-1 text-xs text-muted-foreground">
                          {person.linkType === "auto_email" ? "Matched by exact email" : "Owner confirmed"}
                        </div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      {new Date(person.lastSyncedAt).toLocaleString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
