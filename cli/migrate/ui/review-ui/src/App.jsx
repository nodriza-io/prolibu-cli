import { Routes, Route } from "react-router-dom";
import CrmSelector from "./pages/CrmSelector";
import MigrationShell from "./components/MigrationShell";
import Dashboard from "./pages/Dashboard";
import Credentials from "./pages/Credentials";
import SchemaMap from "./pages/SchemaMap";
import ConfigBuilder from "./pages/ConfigBuilder";
import FlowEditor from "./pages/FlowEditor";
import Objects from "./pages/Objects";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<CrmSelector />} />
      <Route path="/:crm" element={<MigrationShell />}>
        <Route index element={<Dashboard />} />
        <Route path="credentials" element={<Credentials />} />
        <Route path="schema" element={<SchemaMap />} />
        <Route path="config-builder" element={<ConfigBuilder />} />
        <Route path="flow" element={<FlowEditor />} />
        <Route path="objects" element={<Objects />} />
      </Route>
    </Routes>
  );
}
