import { ComingSoon } from '../../components/ui/ComingSoon.js';
import { CogIcon } from '../../components/Icons/index.js';
import { getFeature } from '../../config/features.js';

export function SettingsView(): JSX.Element {
  const feature = getFeature('settings');

  return (
    <ComingSoon
      title={feature?.label ?? 'Settings'}
      description={feature?.description}
      icon={<CogIcon className="icon-svg" />}
    />
  );
}
