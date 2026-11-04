// Lesson text, rendered without a markdown library.
//
// The server sends markdown because the lesson prompt asks for it, and the shapes it actually uses
// are headings, bullets, the "> " notice the server prepends to an uncited lesson, and **bold**.
// Everything is rendered as React text nodes, so model output can never become markup.

function inline(text) {
  const parts = String(text).split("**");
  if (parts.length === 1) return text;
  return parts.map((part, index) => (index % 2 === 1 ? <strong key={index}>{part}</strong> : part));
}

function parse(markdown) {
  const nodes = [];
  let bullets = [];

  const flush = () => {
    if (!bullets.length) return;
    nodes.push(<ul key={`list-${nodes.length}`}>{bullets}</ul>);
    bullets = [];
  };

  String(markdown ?? "")
    .split(/\r?\n/)
    .forEach((line, index) => {
      const text = line.trim();

      if (/^[-*]\s+/.test(text)) {
        bullets.push(<li key={index}>{inline(text.replace(/^[-*]\s+/, ""))}</li>);
        return;
      }
      flush();

      if (!text) return;
      if (/^#{1,4}\s+/.test(text)) {
        nodes.push(<h3 key={index}>{inline(text.replace(/^#{1,4}\s+/, ""))}</h3>);
        return;
      }
      if (text.startsWith(">")) {
        nodes.push(
          <p className="notice notice--info" key={index}>
            {inline(text.replace(/^>\s?/, ""))}
          </p>
        );
        return;
      }
      nodes.push(<p key={index}>{inline(text)}</p>);
    });

  flush();
  return nodes;
}

export default function LessonText({ markdown }) {
  return <div className="lesson">{parse(markdown)}</div>;
}
