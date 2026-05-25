export type AssetSlot = { file: string; alt: string };

export type AssetManifest = {
  version: string;
  description?: string;
  slots: Record<string, AssetSlot>;
};

export type AssetName = string;
