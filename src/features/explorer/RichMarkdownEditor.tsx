import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import { Bold, Italic, Strikethrough, List, ListOrdered, ListTodo, Quote, Link, ImageIcon, Code, CodeXml, Minus, Table2, Pilcrow, Heading1, Heading2, Heading3, MoreHorizontal, X, ArrowUp, ArrowDown } from 'lucide-react';
import { Popover } from '../../components/ui/Popover';
import { usePopoverState } from '../../hooks/usePopoverState';

// Keep images inert until the user explicitly opens a URL; Markdown cannot trigger network reads.
const SafeImage = Image.extend({ addNodeView() { return ({ node }) => { const dom = document.createElement('span'); dom.className = 'workspace-rich-image'; dom.textContent = `▧ ${node.attrs.alt || 'Image'} (${node.attrs.src || ''})`; return { dom }; }; } });

export default function RichMarkdownEditor({ value, onChange, onSave, onBlur }: { value: string; onChange: (value: string) => void; onSave: () => void; onBlur: () => void }) {
  const callbacks = useRef({ onChange, onSave, onBlur }); callbacks.current = { onChange, onSave, onBlur };
  const sent = useRef(value), [find, setFind] = useState(false), [search, setSearch] = useState(''), [searchIndex, setSearchIndex] = useState(0);
  const format = useRef({ eol: value.includes('\r\n') ? '\r\n' : '\n', newline: /\r?\n$/.test(value), bom: value.startsWith('\ufeff') });
  const [insert, setInsert] = useState<'link' | 'image' | null>(null), [url, setUrl] = useState('');
  const more = usePopoverState(), trigger = useRef<HTMLButtonElement>(null), root = useRef<HTMLDivElement>(null), findInput = useRef<HTMLInputElement>(null);
  const extensions = useMemo(() => [StarterKit.configure({ link: { openOnClick: false, autolink: false, linkOnPaste: false }, trailingNode: false }), TaskList, TaskItem.configure({ nested: true }), TableKit.configure({ table: { resizable: false } }), SafeImage.configure({ inline: true }), Markdown], []);
  const editor = useEditor({
    extensions, content: value, contentType: 'markdown', immediatelyRender: true, autofocus: 'start',
    editorProps: { attributes: { class: 'workspace-rich-document', spellcheck: 'false', 'aria-label': 'Markdown document' },
      handleKeyDown: (_view, event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); callbacks.current.onSave(); return true; }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); setFind(true); requestAnimationFrame(() => findInput.current?.focus()); return true; }
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      let markdown = editor.getMarkdown().replace(/^\ufeff/, '').replace(/\r?\n/g, format.current.eol);
      if (format.current.newline && !markdown.endsWith(format.current.eol)) markdown += format.current.eol;
      if (format.current.bom) markdown = '\ufeff' + markdown;
      sent.current = markdown; callbacks.current.onChange(markdown);
    },
    onBlur: () => callbacks.current.onBlur(),
  }, []);
  const active = useEditorState({ editor, selector: ({ editor }) => editor ? ['paragraph','heading','bold','italic','strike','bulletList','orderedList','taskList','blockquote','codeBlock'].filter(name => editor.isActive(name)).join(',') + editor.getAttributes('heading').level : '' });
  useEffect(() => { if (editor && !editor.isDestroyed && value !== sent.current) { format.current = { eol: value.includes('\r\n') ? '\r\n' : '\n', newline: /\r?\n$/.test(value), bom: value.startsWith('\ufeff') }; editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false }); sent.current = value; } }, [editor, value]);
  const findMatch = (direction: number) => {
    if (!editor || !search) return;
    const positions: { from: number; to: number }[] = [];
    editor.state.doc.descendants((node, position) => { if (!node.isText || !node.text) return; const needle = search.toLowerCase(), text = node.text.toLowerCase(); for (let at = text.indexOf(needle); at >= 0 && positions.length < 1000; at = text.indexOf(needle, at + Math.max(1, needle.length))) positions.push({ from: position + at, to: position + at + search.length }); });
    if (!positions.length) return;
    const next = (searchIndex + direction + positions.length) % positions.length; setSearchIndex(next); editor.chain().setTextSelection(positions[next]).scrollIntoView().run();
  };
  if (!editor) return null;
  const button = (label: string, Glyph: typeof Bold, run: () => void, selected?: boolean) => <button type="button" className="btn-icon" title={label} aria-label={label} aria-pressed={selected} onMouseDown={event => event.preventDefault()} onClick={run}><Glyph size={15} strokeWidth={1.7} /></button>;
  const linkUrl = /^(https?:\/\/|mailto:)[^\s]+$/i.test(url.trim());
  return <div className="workspace-rich-shell" ref={root}>
    <div className="workspace-rich-toolbar" role="toolbar" aria-label="Markdown formatting" data-active={active}>
      {button('Paragraph', Pilcrow, () => editor.chain().focus().setParagraph().run(), editor.isActive('paragraph'))}
      {button('Heading 1', Heading1, () => editor.chain().focus().toggleHeading({ level: 1 }).run(), editor.isActive('heading', { level: 1 }))}
      {button('Heading 2', Heading2, () => editor.chain().focus().toggleHeading({ level: 2 }).run(), editor.isActive('heading', { level: 2 }))}
      {button('Heading 3', Heading3, () => editor.chain().focus().toggleHeading({ level: 3 }).run(), editor.isActive('heading', { level: 3 }))}<span className="workspace-toolbar-divider" />
      {button('Bold', Bold, () => editor.chain().focus().toggleBold().run(), editor.isActive('bold'))}
      {button('Italic', Italic, () => editor.chain().focus().toggleItalic().run(), editor.isActive('italic'))}
      {button('Strikethrough', Strikethrough, () => editor.chain().focus().toggleStrike().run(), editor.isActive('strike'))}<span className="workspace-toolbar-divider" />
      {button('Bullet list', List, () => editor.chain().focus().toggleBulletList().run(), editor.isActive('bulletList'))}
      {button('Numbered list', ListOrdered, () => editor.chain().focus().toggleOrderedList().run(), editor.isActive('orderedList'))}
      {button('Task list', ListTodo, () => editor.chain().focus().toggleTaskList().run(), editor.isActive('taskList'))}<span className="workspace-toolbar-divider" />
      {button('Quote', Quote, () => editor.chain().focus().toggleBlockquote().run(), editor.isActive('blockquote'))}
      {button('Insert link', Link, () => { setInsert('link'); setUrl(editor.getAttributes('link').href ?? ''); })}
      {button('Insert image', ImageIcon, () => { setInsert('image'); setUrl(''); })}
      <button className="btn-icon" ref={trigger} title="More formatting" aria-label="More formatting" aria-expanded={more.present} onClick={more.toggle}><MoreHorizontal size={16} /></button>
      <Popover isOpen={more.present} isClosing={more.closing} triggerRef={trigger} onClose={more.close} floating floatingWidth={190} className="workspace-options-menu">
        <button onClick={() => { editor.chain().focus().toggleCode().run(); more.close(); }}><Code size={14} />Inline code</button>
        <button onClick={() => { editor.chain().focus().toggleCodeBlock().run(); more.close(); }}><CodeXml size={14} />Code block</button>
        <button onClick={() => { editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); more.close(); }}><Table2 size={14} />Table</button>
        <button onClick={() => { editor.chain().focus().setHorizontalRule().run(); more.close(); }}><Minus size={14} />Horizontal rule</button>
      </Popover>
    </div>
    {insert && <form className="workspace-rich-insert" onSubmit={event => { event.preventDefault(); if (!linkUrl) return; if (insert === 'link') editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run(); else editor.chain().focus().setImage({ src: url.trim(), alt: 'Image' }).run(); setInsert(null); }}><input autoFocus aria-label={insert === 'link' ? 'Link URL' : 'Image URL'} placeholder="https://…" value={url} onChange={event => setUrl(event.target.value)} /><button className="btn btn-secondary btn-sm" disabled={!linkUrl}>Insert</button><button type="button" className="btn-icon" title="Cancel" onClick={() => setInsert(null)}><X size={14} /></button></form>}
    {find && <div className="workspace-rich-find"><input ref={findInput} aria-label="Find in Markdown" placeholder="Find" value={search} onChange={event => { setSearch(event.target.value); setSearchIndex(-1); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); findMatch(event.shiftKey ? -1 : 1); } if (event.key === 'Escape') { event.preventDefault(); setFind(false); editor.commands.focus(); } }} /><button className="btn-icon" title="Previous match" onClick={() => findMatch(-1)}><ArrowUp size={14} /></button><button className="btn-icon" title="Next match" onClick={() => findMatch(1)}><ArrowDown size={14} /></button><button className="btn-icon" title="Close find" onClick={() => setFind(false)}><X size={14} /></button></div>}
    <div className="workspace-rich-scroll"><EditorContent editor={editor} /></div>
  </div>;
}
