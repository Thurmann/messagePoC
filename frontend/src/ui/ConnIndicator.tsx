import { connView } from '../core/selectors';
import { useAppState } from './AppContext';

export function ConnIndicator() {
  const v = useAppState(connView);
  return (
    <span className={v.className ? `conn ${v.className}` : 'conn'} id="conn" title={v.title}>
      {v.text}
    </span>
  );
}
