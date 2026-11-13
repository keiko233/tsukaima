"use client";

export { Alert, CodeBlock, EmptyState, Field, KeyValueList, PluginPage, PluginSection, PluginToolbar, ProgressBar, RelativeTime, Skeleton, Spinner, Stat, StatGrid, StatusBadge, StatusDot } from "./components.tsx";
export type { FieldProps } from "./components.tsx";
export { PluginConfigForm } from "./config-form.tsx";
export type { PluginConfigFormProps } from "./config-form.tsx";
export {
	PluginPanelProvider,
	usePluginConfig,
	usePluginI18n,
	usePluginPanel,
	usePluginRpc,
	usePluginToast,
} from "./context.tsx";
export type {
	PluginConfigApi,
	PluginNotifyApi,
	PluginPanelContextValue,
	PluginRpcApi,
	PluginSummary,
} from "./context.tsx";
export { definePluginUi, resolvePluginUi } from "./define.ts";
export type {
	PluginPanelDefinition,
	PluginPanelIcon,
	PluginUiModuleDefinition,
	PluginUiLoader,
	PluginUiModule,
	ResolvedPluginUi,
} from "./define.ts";
export { Button, ButtonLink, IconButton } from "@tsukaima/ui/components/motion/button";
export type {
	ButtonProps,
	ButtonSize,
	ButtonVariant,
	IconButtonProps,
} from "@tsukaima/ui/components/motion/button";
export { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@tsukaima/ui/components/motion/card";
export { Checkbox } from "@tsukaima/ui/components/motion/checkbox";
export { Input } from "@tsukaima/ui/components/motion/input";
export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@tsukaima/ui/components/motion/select";
export { Switch } from "@tsukaima/ui/components/motion/switch";
export { Tabs, TabsContent, TabsList, TabsTrigger } from "@tsukaima/ui/components/motion/tabs";
export { cn } from "@tsukaima/ui/lib/utils";
export type { PluginI18n, PluginI18nSource } from "../i18n/index.ts";
export { statusText } from "../i18n/index.ts";
