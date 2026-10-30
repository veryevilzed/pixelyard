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
  ]).then(([store, actions, canvas, types, base, transform]) => {
    (window as unknown as { __pe: unknown }).__pe = { store, actions, canvas, types, base, transform };
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
