import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import ChatPage from './pages/ChatPage';
import AgentsGallery from './pages/agents/AgentsGallery';
import AgentDetailPage from './pages/agents/AgentDetailPage';
import SubAgentsPage from './pages/sub-agents/SubAgentsPage';
import ProvidersPage from './pages/ProvidersPage';
import TelegramPage from './pages/TelegramPage';
import SettingsPage from './pages/SettingsPage';
import LogsPage from './pages/LogsPage';
import MemoryPage from './pages/MemoryPage';
import SchedulerPage from './pages/SchedulerPage';
import WarRoomPage from './pages/WarRoomPage';
import AdvancedPage from './pages/AdvancedPage';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<ChatPage />} />
        <Route path="agents" element={<AgentsGallery />} />
        <Route path="agents/:id" element={<AgentDetailPage />} />
        <Route path="sub-agents" element={<SubAgentsPage />} />
        <Route path="sub-agents/:id" element={<AgentDetailPage />} />
        <Route path="providers" element={<ProvidersPage />} />
        <Route path="telegram" element={<TelegramPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="memory" element={<MemoryPage />} />
        <Route path="scheduler" element={<SchedulerPage />} />
        <Route path="war-room" element={<WarRoomPage />} />
        <Route path="war-room/:id" element={<WarRoomPage />} />
        <Route path="advanced" element={<AdvancedPage />} />
        <Route path="advanced/:tab" element={<AdvancedPage />} />
      </Route>
    </Routes>
  );
}
