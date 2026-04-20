import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Chat from "./Chat";
import Compare from "./Compare";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Chat />} />
        <Route path="/compare" element={<Compare />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
