import { Link } from 'wouter';
import { ModuleGrid } from '@/components/modules/ModuleGrid';
import { Button } from '@/components/ui/button';
import { Settings } from 'lucide-react';

export default function Marketing() {
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          asChild
          variant="outline"
          size="sm"
          className="gap-2"
          data-testid="link-module-configuration"
        >
          <Link href="/settings">
            <Settings className="w-4 h-4" /> Module setup in Configuration
          </Link>
        </Button>
      </div>
      <ModuleGrid
        categorySlug="marketing"
        title="Marketing OS & Bridge"
        description="GNIL integration modules and core marketing pipelines."
      />
    </div>
  );
}
