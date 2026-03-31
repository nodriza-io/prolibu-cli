import { Routes, Route } from "react-router-dom";
import CrmSelector from "./pages/CrmSelector";
import MigrationShell from "./components/MigrationShell";
import Dashboard from "./pages/Dashboard";
import SchemaMap from "./pages/SchemaMap";
import FlowEditor from "./pages/FlowEditor";
import Objects from "./pages/Objects";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<CrmSelector />} />
      <Route path="/:crm" element={<MigrationShell />}>
        <Route index element={<Dashboard />} />
        <Route path="schema" element={<SchemaMap />} />
        <Route path="flow" element={<FlowEditor />} />
        <Route path="objects" element={<Objects />} />
      </Route>
    </Routes>
  );
}
