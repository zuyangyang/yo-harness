import { ComingSoon } from '../../components/ui/ComingSoon.js';
import { DocumentDuplicateIcon } from '../../components/Icons/index.js';
import { getFeature } from '../../config/features.js';

export function ArtifactsView(): JSX.Element {
  const feature = getFeature('artifacts');

  return (
    <ComingSoon
      title={feature?.label ?? 'Artifacts'}
      description={feature?.description}
      icon={<DocumentDuplicateIcon className="icon-svg" />}
    />
  );
}
