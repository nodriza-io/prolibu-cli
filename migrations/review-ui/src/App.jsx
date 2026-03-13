import { Routes, Route } from "react-router-dom";
import CrmSelector from "./pages/CrmSelector";
import MigrationShell from "./components/MigrationShell";
import Dashboard from "./pages/Dashboard";
import Credentials from "./pages/Credentials";
import SchemaMap from "./pages/SchemaMap";
import ConfigBuilder from "./pages/ConfigBuilder";
import ProlibuSchema from "./pages/ProlibuSchema";
import Pipelines from "./pages/Pipelines";
import Execution from "./pages/Execution";
import YamlConfig from "./pages/YamlConfig";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<CrmSelector />} />
      <Route path="/:crm" element={<MigrationShell />}>
        <Route index element={<Dashboard />} />
        <Route path="credentials" element={<Credentials />} />
        <Route path="config" element={<YamlConfig />} />
        <Route path="schema" element={<SchemaMap />} />
        <Route path="config-builder" element={<ConfigBuilder />} />
        <Route path="prolibu" element={<ProlibuSchema />} />
        <Route path="pipelines" element={<Pipelines />} />
        <Route path="execution" element={<Execution />} />
      </Route>
    </Routes>
  );
}
