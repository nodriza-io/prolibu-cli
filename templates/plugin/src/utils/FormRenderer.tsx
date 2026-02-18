import React, { useEffect, useMemo } from "react";
import { createForm, onFieldValueChange } from "@formily/core";
import { FormProvider, createSchemaField } from "@formily/react";
import {
  FormItem,
  Input,
  Select,
  Checkbox,
  NumberPicker,
  DatePicker,
  TimePicker,
  Switch,
  Radio,
  Cascader,
  TreeSelect,
  Upload,
  Password,
  FormGrid,
  FormLayout,
  Space,
  ColorPicker,
} from "formily-antd-complete";
import { ConfigProvider, theme } from "antd";

// Create SchemaField with all Formily Antd components
const SchemaField = createSchemaField({
  components: {
    FormItem,
    Input,
    "Input.TextArea": Input.TextArea,
    Select,
    Checkbox,
    "Checkbox.Group": Checkbox.Group,
    NumberPicker,
    DatePicker,
    "DatePicker.RangePicker": DatePicker.RangePicker,
    TimePicker,
    "TimePicker.RangePicker": TimePicker.RangePicker,
    Switch,
    Radio,
    "Radio.Group": Radio.Group,
    Cascader,
    TreeSelect,
    Upload,
    "Upload.Dragger": Upload.Dragger,
    Password,
    FormGrid,
    FormLayout,
    Space,
    ColorPicker,
  },
});

// ============ Schema Transformer ============

/**
 * Transform a simple JSON Schema to Formily-compatible schema
 * Auto-assigns x-decorator and x-component based on type/format if not specified
 */
function transformSchema(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;

  const transformed = { ...schema };

  if (transformed.properties) {
    transformed.properties = Object.entries(transformed.properties).reduce(
      (acc, [key, prop]: [string, any]) => {
        const newProp = { ...prop };

        // Add decorator if not present
        if (!newProp["x-decorator"]) {
          newProp["x-decorator"] = "FormItem";
        }

        // Determine component if not specified
        if (!newProp["x-component"]) {
          if (newProp.enum) {
            newProp["x-component"] = "Select";
            newProp["x-component-props"] = {
              ...newProp["x-component-props"],
              options: newProp.enum.map((val: string, i: number) => ({
                label: newProp.enumNames?.[i] || val,
                value: val,
              })),
            };
          } else if (newProp.type === "boolean") {
            newProp["x-component"] = "Switch";
          } else if (newProp.type === "number" || newProp.type === "integer") {
            newProp["x-component"] = "NumberPicker";
          } else if (newProp.type === "array") {
            newProp["x-component"] = "Select";
            newProp["x-component-props"] = {
              ...newProp["x-component-props"],
              mode: "multiple",
            };
          } else if (newProp.format === "date") {
            newProp["x-component"] = "DatePicker";
          } else if (newProp.format === "date-time") {
            newProp["x-component"] = "DatePicker";
            newProp["x-component-props"] = {
              ...newProp["x-component-props"],
              showTime: true,
            };
          } else if (newProp.format === "time") {
            newProp["x-component"] = "TimePicker";
          } else if (newProp.format === "textarea") {
            newProp["x-component"] = "Input.TextArea";
          } else if (newProp.format === "password") {
            newProp["x-component"] = "Password";
          } else if (newProp.format === "color") {
            newProp["x-component"] = "ColorPicker";
          } else {
            newProp["x-component"] = "Input";
          }
        }

        acc[key] = newProp;
        return acc;
      },
      {} as Record<string, any>,
    );
  }

  return transformed;
}

// ============ FormRenderer Component ============

export interface FormRendererProps {
  /** JSON Schema for the form */
  schema: any;
  /** Initial values */
  initialValues?: Record<string, any>;
  /** Callback when any field value changes */
  onChange?: (values: Record<string, any>) => void;
  /** Callback when form is submitted */
  onSubmit?: (values: Record<string, any>) => void;
  /** Use dark theme (default: true for Plugin Studio) */
  darkMode?: boolean;
}

export const FormRenderer: React.FC<FormRendererProps> = ({
  schema,
  initialValues = {},
  onChange,
  onSubmit,
  darkMode = true,
}) => {
  const form = useMemo(() => {
    return createForm({
      initialValues,
      effects: () => {
        onFieldValueChange("*", () => {
          // Defer to next tick to ensure all values are updated
          setTimeout(() => {
            onChange?.(form.values);
          }, 0);
        });
      },
    });
  }, []);

  // Update form values when initialValues change
  useEffect(() => {
    if (initialValues && Object.keys(initialValues).length > 0) {
      form.setValues(initialValues);
    }
  }, [initialValues, form]);

  const transformedSchema = useMemo(() => transformSchema(schema), [schema]);

  // Antd theme configuration for dark mode
  const themeConfig = darkMode
    ? {
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: "#0d99ff",
          colorBgContainer: "#252525",
          colorBgElevated: "#1a1a1a",
          colorBorder: "#333",
          colorText: "#fff",
          colorTextSecondary: "#a0a0a0",
          borderRadius: 6,
        },
      }
    : {
        token: {
          colorPrimary: "#0d99ff",
          borderRadius: 6,
        },
      };

  return (
    <ConfigProvider theme={themeConfig}>
      <FormProvider form={form}>
        <FormLayout layout="vertical" colon={false}>
          <SchemaField schema={transformedSchema} />
        </FormLayout>
      </FormProvider>
    </ConfigProvider>
  );
};

export default FormRenderer;
