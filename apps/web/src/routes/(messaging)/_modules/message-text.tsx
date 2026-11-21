import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@tsukaima/ui/lib/utils";

const markdownPlugins = [remarkGfm];

export const MessageText = memo(function MessageText({
	text,
	markdown = false,
	className,
}: {
	text: string;
	markdown?: boolean;
	className?: string;
}) {
	if (!markdown) return <p className={cn("whitespace-pre-wrap break-words", className)}>{text}</p>;
	return (
		<div className={cn("message-markdown max-w-full min-w-0 break-words", className)}>
			<Markdown
				remarkPlugins={markdownPlugins}
				skipHtml
				components={{ img: ({ alt }) => <span>{alt}</span> }}
			>
				{text}
			</Markdown>
		</div>
	);
});
