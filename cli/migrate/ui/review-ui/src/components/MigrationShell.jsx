import { MigrationProvider } from "../store";
import Layout from "./Layout";

/**
 * Shell that wraps MigrationProvider around the Layout.
 * Mounts only when a CRM route (/:crm/*) is active, ensuring
 * state is fetched after the CRM has been selected.
 */
export default function MigrationShell() {
  return (
    <MigrationProvider>
      <Layout />
    </MigrationProvider>
  );
}
