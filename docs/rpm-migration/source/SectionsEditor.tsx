// ============================================================================
// SOURCE: prolibu-cli/shared/components/SectionsEditor.tsx
// TARGET: formily-antd-complete/src/rpm/sections-editor/index.tsx
//
// ADAPTACIONES REQUERIDAS (marcadas con 🔧 en el código):
//
//   1. IMPORT RichText  → cambiar de "formily-antd-complete" a "../../rich-text"
//   2. IMPORT mapReadPretty → agregar a la línea de @formily/react
//   3. EXPORT interface  → hacer público SectionsEditorProps
//   4. AGREGAR ReadPretty → componente SectionsEditorPreview
//   5. FORMILY connect   → agregar mapReadPretty(SectionsEditorPreview)
//
// ============================================================================

import React, { useCallback, useMemo, useState } from "react";
import {
  Button,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Typography,
} from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  UnorderedListOutlined,
  CloseOutlined,
  CheckOutlined,
} from "@ant-design/icons";
// 🔧 ADAPTAR #1: cambiar import
// ANTES:  import { connect, mapProps } from "@formily/react";
// DESPUÉS:
import { connect, mapProps } from "@formily/react";
// 🔧 ADAPTAR #2: agregar mapReadPretty
// DESPUÉS: import { connect, mapProps, mapReadPretty } from "@formily/react";

// 🔧 ADAPTAR #1: cambiar path de RichText
// ANTES:  import { RichText } from "formily-antd-complete";
// DESPUÉS: import { RichText } from "../../rich-text";
import { RichText } from "formily-antd-complete";

const { Text } = Typography;

// ── Types ──────────────────────────────────────────────────────────

interface CustomRow {
  id: string;
  description: string;
  value: string;
  position: "start" | "end";
}

interface SectionItem {
  id: string;
  key: string;
  title: string;
  notes: string;
  order: number;
  customRows: CustomRow[];
}

interface SectionConfig {
  title?: string;
  notes?: string;
  order?: number;
  customRows?: { description: string; value: string; position: string }[];
}

// 🔧 ADAPTAR #3: exportar interface pública
// AGREGAR: export interface SectionsEditorProps { ... }
// export interface SectionsEditorProps {
//   value?: string | Record<string, SectionConfig>;
//   onChange?: (value: string) => void;
//   disabled?: boolean;
//   readOnly?: boolean;
// }

// ── Helpers ────────────────────────────────────────────────────────

let idCounter = 0;
const uid = () => `sec-${Date.now()}-${++idCounter}`;

const objectToArray = (
  obj: Record<string, SectionConfig> | string | null | undefined,
): SectionItem[] => {
  let parsed = obj;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  if (!parsed || typeof parsed !== "object") return [];

  return Object.entries(parsed as Record<string, SectionConfig>).map(
    ([key, config]) => ({
      id: uid(),
      key,
      title: config?.title || "",
      notes: config?.notes || "",
      order: config?.order ?? 0,
      customRows: (config?.customRows || []).map((row) => ({
        id: uid(),
        description: row.description || "",
        value: row.value || "",
        position: (row.position as "start" | "end") || "end",
      })),
    }),
  );
};

const arrayToObject = (
  arr: SectionItem[],
): Record<string, SectionConfig> => {
  const result: Record<string, SectionConfig> = {};
  arr.forEach((section) => {
    if (section.key) {
      result[section.key] = {
        title: section.title,
        notes: section.notes,
        order: section.order,
        customRows: (section.customRows || []).map((row) => ({
          description: row.description,
          value: row.value,
          position: row.position,
        })),
      };
    }
  });
  return result;
};

// ── Position options ───────────────────────────────────────────────

const positionOptions = [
  { label: "Al inicio", value: "start" },
  { label: "Al final", value: "end" },
];

// ── Styles ─────────────────────────────────────────────────────────

const editorStyles: Record<string, React.CSSProperties> = {
  trigger: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    cursor: "pointer",
    width: "100%",
  },
  triggerText: {
    flex: 1,
    fontSize: 13,
    color: "#999",
    fontStyle: "italic",
  },
  sectionsList: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  sectionCard: {
    background: "#f5f5f5",
    border: "1px solid #d9d9d9",
    borderRadius: 8,
    padding: 12,
  },
  sectionHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  sectionFields: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: 8,
  },
  sectionNotes: {
    marginTop: 8,
  },
  customRowsSection: {
    marginTop: 12,
    paddingTop: 12,
    borderTop: "1px dashed #d9d9d9",
  },
  customRowsHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  customRow: {
    background: "#fff",
    border: "1px solid #eee",
    borderRadius: 4,
    padding: 8,
    marginBottom: 8,
  },
  customRowFields: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap" as const,
  },
  addBtn: {
    borderStyle: "dashed",
    borderRadius: 8,
    width: "100%",
  },
};

// ── Component ──────────────────────────────────────────────────────

interface SectionsEditorInnerProps {
  value?: string | Record<string, SectionConfig>;
  onChange?: (value: string) => void;
  disabled?: boolean;
}

const SectionsEditorInner: React.FC<SectionsEditorInnerProps> = ({
  value,
  onChange,
  disabled,
}) => {
  const [open, setOpen] = useState(false);
  const [localSections, setLocalSections] = useState<SectionItem[]>([]);

  const sectionCount = useMemo(() => {
    const arr = objectToArray(value);
    return arr.length;
  }, [value]);

  const handleOpen = useCallback(() => {
    const sections = objectToArray(value);
    sections.sort((a, b) => (a.order || 0) - (b.order || 0));
    setLocalSections(sections);
    setOpen(true);
  }, [value]);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, []);

  const handleSave = useCallback(() => {
    const result = arrayToObject(localSections);
    onChange?.(JSON.stringify(result));
    setOpen(false);
  }, [localSections, onChange]);

  const updateSection = useCallback(
    (id: string, updates: Partial<SectionItem>) => {
      setLocalSections((prev) =>
        prev.map((s) => (s.id === id ? { ...s, ...updates } : s)),
      );
    },
    [],
  );

  const addSection = useCallback(() => {
    setLocalSections((prev) => [
      ...prev,
      {
        id: uid(),
        key: `Section ${prev.length + 1}`,
        title: "",
        notes: "",
        order: prev.length,
        customRows: [],
      },
    ]);
  }, []);

  const removeSection = useCallback((id: string) => {
    setLocalSections((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const addCustomRow = useCallback((sectionId: string) => {
    setLocalSections((prev) =>
      prev.map((s) =>
        s.id === sectionId
          ? {
              ...s,
              customRows: [
                ...s.customRows,
                { id: uid(), description: "", value: "", position: "end" as const },
              ],
            }
          : s,
      ),
    );
  }, []);

  const removeCustomRow = useCallback(
    (sectionId: string, rowId: string) => {
      setLocalSections((prev) =>
        prev.map((s) =>
          s.id === sectionId
            ? {
                ...s,
                customRows: s.customRows.filter((r) => r.id !== rowId),
              }
            : s,
        ),
      );
    },
    [],
  );

  const updateCustomRow = useCallback(
    (sectionId: string, rowId: string, updates: Partial<CustomRow>) => {
      setLocalSections((prev) =>
        prev.map((s) =>
          s.id === sectionId
            ? {
                ...s,
                customRows: s.customRows.map((r) =>
                  r.id === rowId ? { ...r, ...updates } : r,
                ),
              }
            : s,
        ),
      );
    },
    [],
  );

  return (
    <>
      <div style={editorStyles.trigger} onClick={disabled ? undefined : handleOpen}>
        <Text style={editorStyles.triggerText}>
          {sectionCount > 0
            ? `${sectionCount} sección(es) configurada(s)`
            : "Configurar secciones"}
        </Text>
        <Button
          type="primary"
          icon={<EditOutlined />}
          size="small"
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            if (!disabled) handleOpen();
          }}
        >
          Editar
        </Button>
      </div>

      <Modal
        title={
          <Space>
            <UnorderedListOutlined />
            <span>Configuración de Secciones</span>
          </Space>
        }
        open={open}
        onCancel={handleClose}
        width={640}
        styles={{ body: { maxHeight: "60vh", overflowY: "auto", padding: 16 } }}
        footer={
          <Space>
            <Button icon={<CloseOutlined />} onClick={handleClose}>
              Cancelar
            </Button>
            <Button type="primary" icon={<CheckOutlined />} onClick={handleSave}>
              Guardar
            </Button>
          </Space>
        }
        destroyOnClose
      >
        <div style={editorStyles.sectionsList}>
          {localSections.map((section) => (
            <div key={section.id} style={editorStyles.sectionCard}>
              <div style={editorStyles.sectionHeader}>
                <Input
                  value={section.key}
                  onChange={(e) =>
                    updateSection(section.id, { key: e.target.value })
                  }
                  placeholder="Clave de familia"
                  style={{ flex: 1, marginRight: 8, fontWeight: 600 }}
                />
                <Button
                  type="text"
                  danger
                  icon={<DeleteOutlined />}
                  size="small"
                  onClick={() => removeSection(section.id)}
                />
              </div>

              <div style={editorStyles.sectionFields}>
                <Input
                  value={section.title}
                  onChange={(e) =>
                    updateSection(section.id, { title: e.target.value })
                  }
                  placeholder="Título personalizado (opcional)"
                  addonBefore="Título"
                  style={{ flex: 1, minWidth: 200 }}
                />
                <InputNumber
                  value={section.order}
                  onChange={(val) =>
                    updateSection(section.id, { order: val ?? 0 })
                  }
                  addonBefore="Orden"
                  style={{ width: 140 }}
                />
              </div>

              <div style={editorStyles.sectionNotes}>
                <Text type="secondary" style={{ fontSize: 12, marginBottom: 4, display: "block" }}>
                  Notas
                </Text>
                <RichText
                  value={section.notes}
                  onChange={(html: string) =>
                    updateSection(section.id, { notes: html })
                  }
                  minHeight={60}
                />
              </div>

              <div style={editorStyles.customRowsSection}>
                <div style={editorStyles.customRowsHeader}>
                  <Text strong type="secondary" style={{ fontSize: 12 }}>
                    Filas Personalizadas
                  </Text>
                  <Button
                    type="text"
                    size="small"
                    icon={<PlusOutlined />}
                    onClick={() => addCustomRow(section.id)}
                  />
                </div>

                {section.customRows.map((row) => (
                  <div key={row.id} style={editorStyles.customRow}>
                    <div style={editorStyles.customRowFields}>
                      <Input
                        value={row.description}
                        onChange={(e) =>
                          updateCustomRow(section.id, row.id, {
                            description: e.target.value,
                          })
                        }
                        placeholder="Descripción"
                        style={{ flex: 2, minWidth: 150 }}
                      />
                      <Input
                        value={row.value}
                        onChange={(e) =>
                          updateCustomRow(section.id, row.id, {
                            value: e.target.value,
                          })
                        }
                        placeholder="Valor"
                        style={{ flex: 1, minWidth: 100 }}
                      />
                      <Select
                        value={row.position}
                        onChange={(val) =>
                          updateCustomRow(section.id, row.id, {
                            position: val,
                          })
                        }
                        options={positionOptions}
                        style={{ width: 120 }}
                      />
                      <Button
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        size="small"
                        onClick={() => removeCustomRow(section.id, row.id)}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}

          <Button
            type="dashed"
            icon={<PlusOutlined />}
            onClick={addSection}
            style={editorStyles.addBtn}
          >
            Agregar Sección
          </Button>
        </div>
      </Modal>
    </>
  );
};

// 🔧 ADAPTAR #4: AGREGAR ReadPretty preview
// const SectionsEditorPreview: React.FC<{ value?: string }> = ({ value }) => {
//   if (!value) return <span>-</span>;
//   try {
//     const parsed = typeof value === "string" ? JSON.parse(value) : value;
//     const count = Object.keys(parsed).length;
//     return <span>{count} sección(es)</span>;
//   } catch {
//     return <span>-</span>;
//   }
// };

// ── Formily integration ────────────────────────────────────────────

// 🔧 ADAPTAR #5: agregar mapReadPretty al connect
// ANTES:
export const SectionsEditor = connect(
  SectionsEditorInner,
  mapProps((props: any) => ({
    ...props,
    disabled: props.disabled || props.readOnly,
  })),
);
// DESPUÉS:
// export const SectionsEditor = connect(
//   SectionsEditorInner,
//   mapProps((props: any) => ({
//     ...props,
//     disabled: props.disabled || props.readOnly,
//   })),
//   mapReadPretty(SectionsEditorPreview),
// );

export default SectionsEditor;
