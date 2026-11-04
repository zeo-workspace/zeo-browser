// Story 068, task 1.1 — Unchanged Behavior 1: ordinary thread Markdown renders to the same HTML
// as zeo-browser 0.1.0 (markdown-it 15.0.2, `html: false`), byte for byte, after the move to
// 15.0.3. Contract: `renderMarkdown(md: string): string` from `src/sidebar/markdown.ts`.
//
// Every expected string below was produced by 0.1.0's own `renderMarkdown` on 2026-10-25, before
// the move: it is the baseline, so never regenerate it from the new version — a difference here
// is a change in what the sidebar shows, to be explained, not re-recorded.
//
// Hostile halves first. 15.0.3 rewrote the block rule that parses link reference definitions (the
// GHSA-gfr2-rv44-r23c fix), so the inputs most likely to change are the ones that rule touches:
//   1. definitions spread over several lines that MUST still resolve — a fix that bails out early
//      would turn them into text (one definition wrongly split into paragraphs);
//   2. look-alikes that MUST still stay text — a fix that accepts more would swallow them into a
//      definition and the reader would lose the line (text wrongly collapsed into a definition);
//   3. only then ordinary thread Markdown, and the entity and URL decoding every link goes through.
// One difference is intended and pinned on its own, last: a label over 999 characters
// (CommonMark §6.3), which 15.0.2 accepted and 15.0.3 refuses.
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/sidebar/markdown.js";

type Cases = ReadonlyArray<readonly [name: string, source: string, html: string]>;

/** The longest label CommonMark allows (§6.3): 999 characters. */
const LONG = "a".repeat(999);

const RESOLVE: Cases = [
  [
    "label split over two lines",
    "[foo\nbar]: https://a.example/u\n\n[foo bar]",
    '<p><a href="https://a.example/u" target="_blank" rel="noopener noreferrer">foo bar</a></p>\n',
  ],
  [
    "destination on the next line",
    "[foo]:\nhttps://a.example/u\n\n[foo]",
    '<p><a href="https://a.example/u" target="_blank" rel="noopener noreferrer">foo</a></p>\n',
  ],
  [
    "title on the next line",
    '[foo]: https://a.example/u\n"the title"\n\n[foo]',
    '<p><a href="https://a.example/u" title="the title" target="_blank" rel="noopener noreferrer">foo</a></p>\n',
  ],
  [
    "title over several lines",
    "[foo]: https://a.example/u '\ntitle\nline1\nline2\n'\n\n[foo]",
    '<p><a href="https://a.example/u" title="\ntitle\nline1\nline2\n" target="_blank" rel="noopener noreferrer">foo</a></p>\n',
  ],
  [
    "title in parentheses",
    "[foo]: https://a.example/u (paren title)\n\n[foo]",
    '<p><a href="https://a.example/u" title="paren title" target="_blank" rel="noopener noreferrer">foo</a></p>\n',
  ],
  [
    "destination in angle brackets",
    "[foo]: <https://a.example/my url>\n\n[foo]",
    '<p><a href="https://a.example/my%20url" target="_blank" rel="noopener noreferrer">foo</a></p>\n',
  ],
  [
    "escaped bracket in the label",
    "[foo\\]bar]: https://a.example/u\n\n[foo\\]bar]",
    '<p><a href="https://a.example/u" target="_blank" rel="noopener noreferrer">foo]bar</a></p>\n',
  ],
  [
    "label case-folded, non-ASCII",
    "[ΑΓΩ]: https://a.example/φου\n\n[αγω]",
    '<p><a href="https://a.example/%CF%86%CE%BF%CF%85" target="_blank" rel="noopener noreferrer">αγω</a></p>\n',
  ],
  [
    "label of exactly 999 characters",
    "[" + LONG + "]: https://a.example/u\n\n[" + LONG + "]",
    '<p><a href="https://a.example/u" target="_blank" rel="noopener noreferrer">' +
      LONG +
      "</a></p>\n",
  ],
  [
    "definition then a paragraph line",
    '[foo]: https://a.example/u "title"\nnot part of it\n\n[foo]',
    '<p>not part of it</p>\n<p><a href="https://a.example/u" title="title" target="_blank" rel="noopener noreferrer">foo</a></p>\n',
  ],
  [
    "valid destination, title line with trailing text",
    '[foo]: https://a.example/u\n"title" ok\n\n[foo]',
    '<p>&quot;title&quot; ok</p>\n<p><a href="https://a.example/u" target="_blank" rel="noopener noreferrer">foo</a></p>\n',
  ],
  [
    "definition inside a blockquote",
    "> [foo]: https://a.example/u\n\n[foo]",
    '<blockquote></blockquote>\n<p><a href="https://a.example/u" target="_blank" rel="noopener noreferrer">foo</a></p>\n',
  ],
  [
    "two definitions back to back, first wins",
    "[foo]: https://a.example/1\n[foo]: https://a.example/2\n[bar]: https://a.example/3\n\n[foo] [bar]",
    '<p><a href="https://a.example/1" target="_blank" rel="noopener noreferrer">foo</a> <a href="https://a.example/3" target="_blank" rel="noopener noreferrer">bar</a></p>\n',
  ],
  [
    "full, collapsed and shortcut references",
    "[x]: https://a.example/u 'T'\n\n[text][x] [x][] [x]",
    '<p><a href="https://a.example/u" title="T" target="_blank" rel="noopener noreferrer">text</a> <a href="https://a.example/u" title="T" target="_blank" rel="noopener noreferrer">x</a> <a href="https://a.example/u" title="T" target="_blank" rel="noopener noreferrer">x</a></p>\n',
  ],
  ["unsafe destination dropped to its text", "[x]: javascript:alert(1)\n\n[x]", "<p>x</p>\n"],
];

const STAY_TEXT: Cases = [
  ["unclosed label over a few lines", "[a\na\na\na\na\n", "<p>[a\na\na\na\na</p>\n"],
  [
    "unclosed title over a few lines",
    '[a]: /u "x\nx\nx\nx\nx\n',
    "<p>[a]: /u &quot;x\nx\nx\nx\nx</p>\n",
  ],
  [
    "unclosed title on its own line",
    '[a]: https://a.example/u\n"x\nx\nx\nx\nx\n',
    "<p>&quot;x\nx\nx\nx\nx</p>\n",
  ],
  ["label without a colon", "[foo]\nhttps://a.example/u", "<p>[foo]\nhttps://a.example/u</p>\n"],
  [
    "blank line inside the title",
    "[foo]: https://a.example/u 'title\n\nwith blank line'\n\n[foo]",
    "<p>[foo]: https://a.example/u 'title</p>\n<p>with blank line'</p>\n<p>[foo]</p>\n",
  ],
  [
    "blank line inside the label",
    "[foo\n\nbar]: https://a.example/u\n\n[foo bar]",
    "<p>[foo</p>\n<p>bar]: https://a.example/u</p>\n<p>[foo bar]</p>\n",
  ],
  [
    "definition-like line in a code fence",
    "```\n[foo]: https://a.example/u\n```\n\n[foo]",
    "<pre><code>[foo]: https://a.example/u\n</code></pre>\n<p>[foo]</p>\n",
  ],
  [
    "definition-like line indented four spaces",
    "    [foo]: https://a.example/u\n\n[foo]",
    "<pre><code>[foo]: https://a.example/u\n</code></pre>\n<p>[foo]</p>\n",
  ],
  [
    "definition cannot interrupt a paragraph",
    "some text\n[foo]: https://a.example/u\n\n[foo]",
    "<p>some text\n[foo]: https://a.example/u</p>\n<p>[foo]</p>\n",
  ],
  ["empty label", "[]: https://a.example/u\n\n[]", "<p>[]: https://a.example/u</p>\n<p>[]</p>\n"],
];

const ORDINARY: Cases = [
  [
    "headings and emphasis",
    "# Title\n\n## Section\n\nSome *em*, **strong**, ~~gone~~ and `code`.",
    "<h1>Title</h1>\n<h2>Section</h2>\n<p>Some <em>em</em>, <strong>strong</strong>, <s>gone</s> and <code>code</code>.</p>\n",
  ],
  [
    "nested lists",
    "- one\n  - nested\n  - nested two\n- two\n\n1. first\n2. second\n   - inner",
    "<ul>\n<li>one\n<ul>\n<li>nested</li>\n<li>nested two</li>\n</ul>\n</li>\n<li>two</li>\n</ul>\n<ol>\n<li>first</li>\n<li>second\n<ul>\n<li>inner</li>\n</ul>\n</li>\n</ol>\n",
  ],
  [
    "fenced code with a language",
    '```ts\nconst a = 1 < 2 && "x";\n```',
    '<pre><code class="language-ts">const a = 1 &lt; 2 &amp;&amp; &quot;x&quot;;\n</code></pre>\n',
  ],
  [
    "blockquote with a list",
    "> quoted\n> - item\n>\n> more",
    "<blockquote>\n<p>quoted</p>\n<ul>\n<li>item</li>\n</ul>\n<p>more</p>\n</blockquote>\n",
  ],
  [
    "table",
    "| a | b |\n|---|:-:|\n| 1 | 2 |\n| `x` | **y** |",
    '<table>\n<thead>\n<tr>\n<th>a</th>\n<th style="text-align:center">b</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>1</td>\n<td style="text-align:center">2</td>\n</tr>\n<tr>\n<td><code>x</code></td>\n<td style="text-align:center"><strong>y</strong></td>\n</tr>\n</tbody>\n</table>\n',
  ],
  [
    "inline link, autolink, mailto",
    'See [docs](https://a.example/docs "Docs"), <https://b.example> and <me@c.example>.',
    '<p>See <a href="https://a.example/docs" title="Docs" target="_blank" rel="noopener noreferrer">docs</a>, <a href="https://b.example" target="_blank" rel="noopener noreferrer">https://b.example</a> and <a href="mailto:me@c.example" target="_blank" rel="noopener noreferrer">me@c.example</a>.</p>\n',
  ],
  [
    "hard break and horizontal rule",
    "line one  \nline two\\\nline three\n\n---\n\nafter",
    "<p>line one<br>\nline two<br>\nline three</p>\n<hr>\n<p>after</p>\n",
  ],
  [
    "raw HTML is escaped",
    '<div onclick="x()">hi</div>\n\ninline <b>bold</b> & entity &copy; &#35;',
    "<p>&lt;div onclick=&quot;x()&quot;&gt;hi&lt;/div&gt;</p>\n<p>inline &lt;b&gt;bold&lt;/b&gt; &amp; entity © #</p>\n",
  ],
  [
    "image becomes a link",
    "![diagram](https://a.example/p.png) and ![bad](javascript:x)",
    '<p><a href="https://a.example/p.png" target="_blank" rel="noopener noreferrer">image: diagram</a> and image: bad</p>\n',
  ],
  [
    "badge image inside a link",
    "[![CI](https://a.example/b.svg)](https://a.example/ci)",
    '<p><a href="https://a.example/ci" target="_blank" rel="noopener noreferrer">image: CI</a></p>\n',
  ],
  [
    "typical assistant reply",
    "I changed **two files**:\n\n1. `src/a.ts` — added `parse()`\n2. `src/b.ts`\n\n```diff\n- old\n+ new\n```\n\nRun `npm test` to check. See [the PR](https://github.com/o/r/pull/1).",
    '<p>I changed <strong>two files</strong>:</p>\n<ol>\n<li><code>src/a.ts</code> — added <code>parse()</code></li>\n<li><code>src/b.ts</code></li>\n</ol>\n<pre><code class="language-diff">- old\n+ new\n</code></pre>\n<p>Run <code>npm test</code> to check. See <a href="https://github.com/o/r/pull/1" target="_blank" rel="noopener noreferrer">the PR</a>.</p>\n',
  ],
  ["empty and whitespace-only", "   \n\n", ""],
];

const DECODING: Cases = [
  [
    "numeric and named entities, edge code points",
    "&#128; &#129; &#150; &#159; &#0; &#xD800; &#x110000; &#x10FFFF; &amp;amp; &nbsp; &notanentity;",
    "<p>\ufffd \ufffd \ufffd \ufffd \ufffd \ufffd \ufffd \ufffd &amp;amp; \u00a0 &amp;notanentity;</p>\n",
  ],
  [
    "percent-encoding in destinations",
    "[a](https://a.example/%E2%82%AC) [b](https://a.example/%C0%AF%zz) [c](https://a.example/a b) [d](<https://a.example/ü?q=1&r=2#f>)",
    '<p><a href="https://a.example/%E2%82%AC" target="_blank" rel="noopener noreferrer">a</a> <a href="https://a.example/%C0%AF%25zz" target="_blank" rel="noopener noreferrer">b</a> [c](https://a.example/a b) <a href="https://a.example/%C3%BC?q=1&amp;r=2#f" target="_blank" rel="noopener noreferrer">d</a></p>\n',
  ],
  [
    "backslash escapes",
    "\\*not em\\* \\[not a link\\](https://a.example) \\`x\\`",
    "<p>*not em* [not a link](https://a.example) `x`</p>\n",
  ],
];

describe("hostile: multi-line reference definitions still resolve as in 0.1.0", () => {
  it.each(RESOLVE)("%s", (_name, source, html) => {
    expect(renderMarkdown(source)).toBe(html);
  });
});

describe("hostile: definition look-alikes still stay text as in 0.1.0", () => {
  it.each(STAY_TEXT)("%s", (_name, source, html) => {
    expect(renderMarkdown(source)).toBe(html);
  });

  it("an unclosed 20 000-line definition keeps every line as paragraph text", () => {
    const lines = Array.from({ length: 20_000 }, () => "a");
    expect(renderMarkdown("[" + lines.map((l) => l + "\n").join(""))).toBe(
      "<p>[" + lines.join("\n") + "</p>\n",
    );
    const title = Array.from({ length: 20_000 }, () => "x");
    expect(renderMarkdown('[a]: /u "' + title.map((l) => l + "\n").join(""))).toBe(
      "<p>[a]: /u &quot;" + title.join("\n") + "</p>\n",
    );
  });
});

describe("ordinary thread Markdown renders as in 0.1.0", () => {
  it.each(ORDINARY)("%s", (_name, source, html) => {
    expect(renderMarkdown(source)).toBe(html);
  });
});

describe("entity and URL decoding render as in 0.1.0", () => {
  it.each(DECODING)("%s", (_name, source, html) => {
    expect(renderMarkdown(source)).toBe(html);
  });
});

// The one intended difference. 0.1.0 resolved a 1000-character label; CommonMark §6.3 caps a label
// at 999 and 15.0.3 enforces the cap (its fix stops scanning a label there), so the definition and
// its use are both text. Pinned so the change is a decision on record, not a surprise.
it("intended change: a label over 999 characters is text, not a link (CommonMark §6.3)", () => {
  const label = LONG + "a";
  const html = renderMarkdown(`[${label}]: https://a.example/u\n\n[${label}]`);
  expect(html.replaceAll(label, "<1000 a>")).toBe(
    "<p>[<1000 a>]: https://a.example/u</p>\n<p>[<1000 a>]</p>\n",
  );
});
