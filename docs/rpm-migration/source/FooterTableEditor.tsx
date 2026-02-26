// ============================================================================
// SOURCE: prolibu-cli/shared/components/FooterTableEditor.tsx
// TARGET: formily-antd-complete/src/rpm/footer-table-editor/index.tsx
//
// ADAPTACIONES REQUERIDAS (marcadas con 🔧 en el código):
//
//   1. IMPORT mapReadPretty → agregar a la línea de @formily/react
//   2. EXPORT interface    → hacer público FooterTableEditorProps
//   3. AGREGAR ReadPretty  → componente FooterTableEditorPreview
//   4. FORMILY connect     → agregar mapReadPretty(FooterTableEditorPreview)
//
// ============================================================================

import React, { useCallback, useMemo, useState } from "react";
import { Button, Input, Modal, Space, Typography } from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  TableOutlined,
  CloseOutlined,
  CheckOutlined,
} from "@ant-design/icons";
// 🔧 ADAPTAR #1: agregar mapReadPretty
// ANTES:  import { connect, mapProps } from "@formily/react";
// DESPUÉS: import { connect, mapProps, mapReadPretty } from "@formily/react";
import { connect, mapProps } from "@formily/react";

const { Text } = Typography;

// ── Types ──────────────────────────────────────────────────────────

interface FooterRow {
  id: string;
  label: string;
  value: string;
}

// 🔧 ADAPTAR #2: exportar interface pública
// export interface FooterTableEditorProps {
//   value?: string | { label: string; value: string }[];
//   onChange?: (value: string) => void;
//   disabled?: boolean;
//   readOnly?: boolean;
// }

// ── Helpers ────────────────────────────────────────────────────────

let idCounter = 0;
const uid = () => `ftr-${Date.now()}-${++idCounter}`;

const parseRows = (
  val: string | { label: string; value: string }[] | null | undefined,
): FooterRow[] => {
  let arr = val;
  if (typeof arr === "string") {
    try {
      arr = JSON.parse(arr);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((row) => ({
    id: uid(),
    label: row.label || "",
    value: row.value || "",
  }));
};

const serializeRows = (rows: FooterRow[]): string => {
  return JSON.stringify(
    rows
      .filter((r) => r.label || r.value)
      .map((r) => ({ label: r.label, value: r.value })),
  );
};

// ── Styles ─────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  trigger: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    cursor: "pointer",
    width: "100%",
  },
  triggerText: { flex: 1, fontSize: 13, color: "#999", fontStyle: "italic" },
  list: { display: "flex", flexDirection: "column", gap: 12 },
  row: {
    background: "#f5f5f5",
    border: "1px solid #d9d9d9",
    borderRadius: 6,
    padding: 10,
  },
  rowFields: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap" as const,
  },
  addBtn: { borderStyle: "dashed", borderRadius: 6, width: "100%" },
};

// ── Component ──────────────────────────────────────────────────────

interface FooterTableEditorInnerProps {
  value?: string | { label: string; value: string }[];
  onChange?: (value: string) => void;
  disabled?: boolean;
}

const FooterTableEditorInner: React.FC<FooterTableEditorInnerProps> = ({
  value,
  onChange,
  disabled,
}) => {
  const [open, setOpen] = useState(false);
  const [localRows, setLocalRows] = useState<FooterRow[]>([]);

  const rowCount = useMemo(() => parseRows(value).length, [value]);

  const handleOpen = useCallback(() => {
    setLocalRows(parseRows(value));
    setOpen(true);
  }, [value]);

  const handleClose = useCallback(() => setOpen(false), []);

  const handleSave = useCallback(() => {
    onChange?.(serializeRows(localRows));
    setOpen(false);
  }, [localRows, onChange]);

  const updateRow = useCallback(
    (id: string, updates: Partial<FooterRow>) => {
      setLocalRows((prev) =>
        prev.map((r) => (r.id === id ? { ...r, ...updates } : r)),
      );
    },
    [],
  );

  const addRow = useCallback(() => {
    setLocalRows((prev) => [...prev, { id: uid(), label: "", value: "" }]);
  }, []);

  const removeRow = useCallback((id: string) => {
    setLocalRows((prev) => prev.filter((r) => r.id !== id));
  }, []);

  return (
    <>
      <div style={s.trigger} onClick={disabled ? undefined : handleOpen}>
        <Text style={s.triggerText}>
          {rowCount > 0
            ? `${rowCount} fila(s) configurada(s)`
            : "Configurar tabla de condiciones"}
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
            <TableOutlined />
            <span>Tabla de Condiciones</span>
          </Space>
        }
        open={open}
        onCancel={handleClose}
        width={520}
        styles={{
          body: { maxHeight: "60vh", overflowY: "auto", padding: 16 },
        }}
        footer={
          <Space>
            <Button icon={<CloseOutlined />} onClick={handleClose}>
              Cancelar
            </Button>
            <Button
              type="primary"
              icon={<CheckOutlined />}
              onClick={handleSave}
            >
              Guardar
            </Button>
          </Space>
        }
        destroyOnClose
      >
        <div style={s.list}>
          {localRows.map((row) => (
            <div key={row.id} style={s.row}>
              <div style={s.rowFields}>
                <Input
                  value={row.label}
                  onChange={(e) =>
                    updateRow(row.id, { label: e.target.value })
                  }
                  placeholder="Ej: FORMA DE PAGO"
                  style={{ flex: 1, minWidth: 120 }}
                  addonBefore="Etiqueta"
                />
                <Input
                  value={row.value}
                  onChange={(e) =>
                    updateRow(row.id, { value: e.target.value })
                  }
                  placeholder="Ej: Crédito a 30 días"
                  style={{ flex: 2, minWidth: 150 }}
                  addonBefore="Valor"
                />
                <Button
                  type="text"
                  danger
                  icon={<DeleteOutlined />}
                  size="small"
                  onClick={() => removeRow(row.id)}
                />
              </div>
            </div>
          ))}

          <Button
            type="dashed"
            icon={<PlusOutlined />}
            onClick={addRow}
            style={s.addBtn}
          >
            Agregar Fila
          </Button>
        </div>
      </Modal>
    </>
  );
};

// 🔧 ADAPTAR #3: AGREGAR ReadPretty preview
// const FooterTableEditorPreview: React.FC<{ value?: string }> = ({ value }) => {
//   if (!value) return <span>-</span>;
//   try {
//     const parsed = typeof value === "string" ? JSON.parse(value) : value;
//     const count = Array.isArray(parsed) ? parsed.length : 0;
//     return <span>{count} fila(s)</span>;
//   } catch {
//     return <span>-</span>;
//   }
// };

// ── Formily integration ────────────────────────────────────────────

// 🔧 ADAPTAR #4: agregar mapReadPretty al connect
// ANTES:
export const FooterTableEditor = connect(
  FooterTableEditorInner,
  mapProps((props: any) => ({
    ...props,
    disabled: props.disabled || props.readOnly,
  })),
);
// DESPUÉS:
// export const FooterTableEditor = connect(
//   FooterTableEditorInner,
//   mapProps((props: any) => ({
//     ...props,
//     disabled: props.disabled || props.readOnly,
//   })),
//   mapReadPretty(FooterTableEditorPreview),
// );

export default FooterTableEditor;
