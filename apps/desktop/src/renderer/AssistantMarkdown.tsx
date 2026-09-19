import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function safeExternalHref(href: string | undefined): string | undefined {
  if (href === undefined) return undefined;
  try {
    const url = new URL(href);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

const compactPlanBulletPattern = /\s+-\s+(?=\*\*[^*\n]+:\*\*)/gu;
const compactPlanSectionPattern = /\s+(Implementation|Verification):\s*/gu;

export function formatPlanMarkdownForDisplay(content: string): string {
  if (content.includes("\n")) return content;
  const bulletMatches = content.match(compactPlanBulletPattern);
  if (bulletMatches === null || bulletMatches.length < 2) return content;
  return content
    .replace(compactPlanBulletPattern, "\n- ")
    .replace(compactPlanSectionPattern, "\n\n## $1:\n\n");
}

export function AssistantMarkdown({
  content,
}: {
  content: string;
}): React.JSX.Element {
  return (
    <div className="message-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) => {
            const safeHref = safeExternalHref(href);
            return safeHref === undefined ? (
              <span>{children}</span>
            ) : (
              <a href={safeHref} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
          img: ({ alt }) => <span>{`[image: ${alt ?? "unlabeled"}]`}</span>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
