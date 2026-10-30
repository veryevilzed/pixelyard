import { useEffect, useRef } from 'react';
import { activeDoc, useApp } from '../../store';
import { changed } from '../../tools/base';

export function HistoryPanel() {
  useApp((s) => s.tick);
  const doc = activeDoc();
  const curRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    curRef.current?.scrollIntoView({ block: 'nearest' });
  }, [doc?.undoStack.length]);
  if (!doc) return <div className="panel-body note">Нет документа</div>;
  const past = doc.undoStack;
  const future = [...doc.redoStack].reverse();
  const jump = (i: number) => {
    doc.jumpTo(i);
    changed();
  };
  return (
    <div className="panel-body list" style={{ maxHeight: 200 }}>
      <div className={`history-row ${past.length === 0 ? 'current' : ''}`} ref={past.length === 0 ? curRef : undefined} onClick={() => jump(-1)}>
        Исходное состояние
      </div>
      {past.map((e, i) => (
        <div key={e.id} ref={i === past.length - 1 ? curRef : undefined} className={`history-row ${i === past.length - 1 ? 'current' : ''}`} onClick={() => jump(i)}>
          {e.label}
        </div>
      ))}
      {future.map((e, i) => (
        <div key={e.id} className="history-row future" onClick={() => jump(past.length + i)}>
          {e.label}
        </div>
      ))}
    </div>
  );
}
