import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './App.css';
import KanbanApp from './KanbanApp';

createRoot(document.getElementById('kanban-root')!).render(
  <StrictMode>
    <KanbanApp />
  </StrictMode>
);
