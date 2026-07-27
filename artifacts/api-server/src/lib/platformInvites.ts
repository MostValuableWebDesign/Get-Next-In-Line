import { randomBytes } from "crypto";
import type { Request } from "express";
import type { PlatformInvite } from "@workspace/db";

/**
 * Platform invitations — a merchant invites an OFF-platform business to join
 * Get Next In Line via a unique trackable link. Shared helpers between the
 * tenant-scoped invite endpoints (/coop/platform-invites) and the public
 * fast-track registration flow (/public/coop/invites/:token, /join/:token).
 */

/** How long an invite link stays usable. */
export const INVITE_TTL_DAYS = 14;

export function inviteExpiryDate(now = new Date()): Date {
  return new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/** URL-safe, unguessable single-use token (lowercase hex, 48 chars). */
export function generateInviteToken(): string {
  return randomBytes(24).toString("hex");
}

export const INVITE_TOKEN_RE = /^[a-f0-9]{48}$/;

/**
 * Absolute trackable link for an invite, based on the request's own host so
 * it works in dev, behind the preview proxy, and in production alike.
 */
export function buildInviteUrl(req: Request, token: string): string {
  const host = req.get("host") ?? "localhost";
  const proto = req.protocol || "https";
  return `${proto}://${host}/api/join/${token}`;
}

/**
 * Ready-to-copy SMS/email message the merchant sends themselves. Contains the
 * contractual incentive copy personalized with the inviter's business name.
 */
export function buildInviteMessage(opts: {
  inviterName: string;
  invitedBusinessName: string;
  inviteUrl: string;
}): string {
  return (
    `Hi ${opts.invitedBusinessName}! ${opts.inviterName} invited you to Get Next In Line. ` +
    `Join the local merchant network to unlock automated customer cross-promotion with ${opts.inviterName}. ` +
    `Get started here: ${opts.inviteUrl}`
  );
}

/**
 * Display/logic status: an invite that is past its expiry but was never used
 * reads as "expired" even before any row update happens.
 */
export function effectiveInviteStatus(
  invite: Pick<PlatformInvite, "status" | "expiresAt">,
  now = new Date()
): "sent" | "clicked" | "registered" | "expired" {
  if (invite.status === "registered") return "registered";
  if (invite.status === "expired" || invite.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }
  return invite.status === "clicked" ? "clicked" : "sent";
}
