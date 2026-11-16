import { UserPlus, Users, UserRoundCheck, type LucideIcon } from "lucide-react";
import type { RequestRow } from "@/lib/api";
import { m } from "@/paraglide/messages";

export function requestKindLabel(kind: RequestRow["kind"]): string {
	switch (kind) {
		case "friend":
			return m.friend_request();
		case "group-add":
			return m.group_add_request();
		case "group-invite":
			return m.group_invite_request();
	}
}

export function requestStatusLabel(status: RequestRow["status"]): string {
	switch (status) {
		case "pending":
			return m.request_pending();
		case "approved":
			return m.request_approved();
		case "rejected":
			return m.request_rejected();
		case "failed":
			return m.request_failed();
		case "uncertain":
			return m.request_uncertain();
	}
}

export function requestStatusClass(status: RequestRow["status"]): string {
	switch (status) {
		case "pending":
			return "bg-warning/10 text-warning";
		case "approved":
			return "bg-success/10 text-success";
		case "rejected":
			return "bg-muted text-muted-foreground";
		case "failed":
			return "bg-destructive/10 text-destructive";
		case "uncertain":
			return "bg-warning/10 text-warning";
	}
}

export function requestIcon(kind: RequestRow["kind"]): LucideIcon {
	switch (kind) {
		case "friend":
			return UserPlus;
		case "group-add":
			return UserRoundCheck;
		case "group-invite":
			return Users;
	}
}
