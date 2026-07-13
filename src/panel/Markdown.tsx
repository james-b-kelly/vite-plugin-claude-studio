import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import classes from "./Markdown.module.css";

/**
 * Markdown rendering for the Studio log.
 *
 * Backed by react-markdown + remark-gfm (GFM = tables, strikethrough, task
 * lists, autolinks), so the full gamut Claude emits — headings, lists,
 * blockquotes, fenced code, tables — renders properly. Styled dark via
 * `Markdown.module.css` to match the dev-tool panel.
 *
 * react-markdown does not render raw HTML by default, so untrusted-ish model
 * output can't inject markup. Links are forced to open in a new tab.
 */

const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
};

export function MarkdownText({ text }: { text: string }) {
  return (
    <div className={classes.md}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
