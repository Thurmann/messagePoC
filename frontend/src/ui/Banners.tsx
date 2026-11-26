import { banBannerText } from '../core/selectors';
import { useAppState } from './AppContext';

export function Banners() {
  const setup = useAppState((s) => s.auth.setupNotice);
  const warn = useAppState((s) => s.warnText);
  const ban = useAppState(banBannerText);
  return (
    <>
      <div className="notice" id="setup" hidden={!setup}>
        {setup}
      </div>
      <div className="banner warn" id="warn-banner" role="status" hidden={warn === null}>
        {warn}
      </div>
      <div className="banner ban" id="ban-banner" role="alert" hidden={ban === null}>
        {ban}
      </div>
    </>
  );
}
