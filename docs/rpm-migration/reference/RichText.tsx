// ============================================================================
// REFERENCIA: formily-antd-complete/src/rich-text/index.tsx
//
// Este archivo es el PATRÓN CANÓNICO para widgets Formily en el paquete.
// Los nuevos componentes (SectionsEditor, FooterTableEditor) DEBEN seguir
// exactamente esta estructura:
//
//   1. export interface {Name}Props  → tipado público
//   2. const {Name}Inner             → componente de edición
//   3. const {Name}Preview           → componente read-only (mapReadPretty)
//   4. export const {Name} = connect(Inner, mapProps(...), mapReadPretty(Preview))
//   5. export default {Name}
//
// ============================================================================

import { connect, mapProps, mapReadPretty } from '@formily/react'
import { Button, Divider, Space, theme } from 'antd'
import {
  BoldOutlined,
  ItalicOutlined,
  UnderlineOutlined,
  UnorderedListOutlined,
  OrderedListOutlined,
  UndoOutlined,
  RedoOutlined,
} from '@ant-design/icons'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import React, { useEffect, useRef } from 'react'

const { useToken } = theme

// ── Types ──────────────────────────────────────────────────────────

export interface RichTextProps {
  value?: string
  onChange?: (html: string) => void
  disabled?: boolean
  readOnly?: boolean
  minHeight?: number
  placeholder?: string
  style?: React.CSSProperties
}

// ── Toolbar Button ─────────────────────────────────────────────────

const ToolbarButton: React.FC<{
  onClick: () => void
  isActive?: boolean
  icon: React.ReactNode
  title: string
  disabled?: boolean
  activeColor?: string
  mutedColor?: string
}> = ({
  onClick,
  isActive,
  icon,
  title,
  disabled,
  activeColor,
  mutedColor,
}) => (
  <Button
    type={isActive ? 'primary' : 'text'}
    size="small"
    icon={icon}
    onClick={onClick}
    title={title}
    disabled={disabled}
    style={{
      minWidth: 28,
      height: 28,
      ...(isActive ? {} : { color: mutedColor }),
    }}
  />
)

// ── Inner Editor Component ─────────────────────────────────────────

const RichTextInner: React.FC<RichTextProps> = ({
  value,
  onChange,
  disabled = false,
  readOnly = false,
  minHeight = 80,
  placeholder,
  style,
}) => {
  const { token } = useToken()
  const isEditable = !disabled && !readOnly
  const isInternalChange = useRef(false)

  const editor = useEditor({
    extensions: [StarterKit, Underline],
    content: value || '',
    editable: isEditable,
    onUpdate: ({ editor }) => {
      isInternalChange.current = true
      onChange?.(editor.getHTML())
    },
    editorProps: {
      attributes: {
        style: 'outline: none; min-height: inherit;',
      },
    },
  })

  useEffect(() => {
    if (!editor) return
    if (isInternalChange.current) {
      isInternalChange.current = false
      return
    }
    const currentHTML = editor.getHTML()
    if (value !== currentHTML) {
      editor.commands.setContent(value || '', false)
    }
  }, [value, editor])

  useEffect(() => {
    if (editor) {
      editor.setEditable(isEditable)
    }
  }, [isEditable, editor])

  if (!editor) return null

  return (
    <div
      style={{
        border: `1px solid ${token.colorBorder}`,
        borderRadius: token.borderRadius,
        background: token.colorBgContainer,
        overflow: 'hidden',
        ...style,
      }}
    >
      {isEditable && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '4px 8px',
            borderBottom: `1px solid ${
              token.colorBorderSecondary || token.colorBorder
            }`,
            background: token.colorBgElevated,
            flexWrap: 'wrap',
            gap: 2,
          }}
        >
          <Space.Compact size="small">
            <ToolbarButton
              onClick={() => editor.chain().focus().toggleBold().run()}
              isActive={editor.isActive('bold')}
              icon={<BoldOutlined />}
              title="Bold"
              activeColor={token.colorPrimary}
              mutedColor={token.colorTextSecondary}
            />
            <ToolbarButton
              onClick={() => editor.chain().focus().toggleItalic().run()}
              isActive={editor.isActive('italic')}
              icon={<ItalicOutlined />}
              title="Italic"
              activeColor={token.colorPrimary}
              mutedColor={token.colorTextSecondary}
            />
            <ToolbarButton
              onClick={() => editor.chain().focus().toggleUnderline().run()}
              isActive={editor.isActive('underline')}
              icon={<UnderlineOutlined />}
              title="Underline"
              activeColor={token.colorPrimary}
              mutedColor={token.colorTextSecondary}
            />
          </Space.Compact>

          <Divider type="vertical" style={{ margin: '0 4px' }} />

          <Space.Compact size="small">
            <ToolbarButton
              onClick={() => editor.chain().focus().toggleBulletList().run()}
              isActive={editor.isActive('bulletList')}
              icon={<UnorderedListOutlined />}
              title="Bullet List"
              activeColor={token.colorPrimary}
              mutedColor={token.colorTextSecondary}
            />
            <ToolbarButton
              onClick={() => editor.chain().focus().toggleOrderedList().run()}
              isActive={editor.isActive('orderedList')}
              icon={<OrderedListOutlined />}
              title="Ordered List"
              activeColor={token.colorPrimary}
              mutedColor={token.colorTextSecondary}
            />
          </Space.Compact>

          <Divider type="vertical" style={{ margin: '0 4px' }} />

          <Space.Compact size="small">
            <ToolbarButton
              onClick={() => editor.chain().focus().undo().run()}
              icon={<UndoOutlined />}
              title="Undo"
              mutedColor={token.colorTextSecondary}
            />
            <ToolbarButton
              onClick={() => editor.chain().focus().redo().run()}
              icon={<RedoOutlined />}
              title="Redo"
              mutedColor={token.colorTextSecondary}
            />
          </Space.Compact>
        </div>
      )}

      <div
        style={{
          minHeight,
          padding: '8px 12px',
          cursor: isEditable ? 'text' : 'default',
          color: token.colorText,
        }}
        onClick={() => isEditable && editor.commands.focus()}
      >
        <style>{`
          .ProseMirror { outline: none; min-height: inherit; }
          .ProseMirror p { margin: 0 0 0.4em 0; }
          .ProseMirror ul, .ProseMirror ol { padding-left: 1.5em; margin: 0.2em 0; }
          .ProseMirror p.is-editor-empty:first-child::before {
            content: attr(data-placeholder);
            float: left;
            color: ${token.colorTextQuaternary || '#aaa'};
            pointer-events: none;
            height: 0;
          }
        `}</style>
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}

// ── ReadPretty Preview ─────────────────────────────────────────────

const RichTextPreview: React.FC<{ value?: string }> = ({ value }) => {
  if (!value) return <span>-</span>
  return (
    <div
      dangerouslySetInnerHTML={{ __html: value }}
      style={{ lineHeight: 1.6 }}
    />
  )
}

// ── Formily Integration ────────────────────────────────────────────

export const RichText = connect(
  RichTextInner,
  mapProps((props: any) => {
    const { onChange, value, ...rest } = props
    return {
      ...rest,
      value,
      onChange: (html: string) => {
        onChange?.(html)
      },
    }
  }),
  mapReadPretty(RichTextPreview)
)

export default RichText
