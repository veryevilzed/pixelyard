import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useApp } from '../store';
import { ColorPanel } from './panels/ColorPanel';
import { Navigator } from './panels/Navigator';
import { HistoryPanel } from './panels/HistoryPanel';
import { LayersActions, LayersPanel } from './panels/LayersPanel';
import { SlicesActions, SlicesPanel } from './panels/SlicesPanel';

type PanelKey = 'navigator' | 'color' | 'layers' | 'slices' | 'history';

function Panel({ id, title, actions, grow, children }: { id: PanelKey; title: string; actions?: ReactNode; grow?: boolean; children: ReactNode }) {
  const open = useApp((s) => s.panels[id]);
  const toggle = () => useApp.setState((s) => ({ panels: { ...s.panels, [id]: !s.panels[id] } }));
  return (
    <div className={`panel ${open && grow ? 'grow' : ''}`}>
      <div className="panel-head" onClick={toggle}>
        <ChevronRight size={12} className={`chev ${open ? 'open' : ''}`} />
        {title}
        {open && actions && (
          <span className="actions" onClick={(e) => e.stopPropagation()}>
            {actions}
          </span>
        )}
      </div>
      {open && children}
    </div>
  );
}

export function Sidebar() {
  return (
    <div className="sidebar">
      <Panel id="navigator" title="Навигатор">
        <Navigator />
      </Panel>
      <Panel id="color" title="Цвет">
        <ColorPanel />
      </Panel>
      <Panel id="layers" title="Слои" actions={<LayersActions />} grow>
        <LayersPanel />
      </Panel>
      <Panel id="slices" title="Слайсы" actions={<SlicesActions />}>
        <SlicesPanel />
      </Panel>
      <Panel id="history" title="История">
        <HistoryPanel />
      </Panel>
    </div>
  );
}
