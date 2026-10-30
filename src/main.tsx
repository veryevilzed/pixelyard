import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

if (import.meta.env.DEV) {
  // отладочный доступ к модулям из консоли (только в dev-сборке)
  void Promise.all([
    import('./store'),
    import('./actions'),
    import('./core/canvas'),
    import('./core/types'),
    import('./tools/base'),
    import('./tools/transform'),
    import('./atlasActions'),
    import('./core/atlas'),
    import('./core/atlasDoc'),
    import('./core/pack'),
  ]).then(([store, actions, canvas, types, base, transform, atlasActions, atlas, atlasDoc, pack]) => {
    (window as unknown as { __pe: unknown }).__pe = { store, actions, canvas, types, base, transform, atlasActions, atlas, atlasDoc, pack };
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
