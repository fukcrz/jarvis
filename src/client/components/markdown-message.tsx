import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeSanitize];

interface MarkdownMessageProps {
  text: string;
  streaming?: boolean;
}

export function MarkdownMessage({ text, streaming = false }: MarkdownMessageProps) {
  return <>
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>{text}</ReactMarkdown>
    {streaming ? <span className="streaming-cursor" aria-hidden="true" /> : null}
  </>;
}
