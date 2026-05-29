// Ambient type references for the API program.
//
// `@types/multer` augments the global `Express.Multer` namespace (used as
// `Express.Multer.File` in the upload controllers). Under TypeScript 6 that
// augmentation is no longer auto-included just by having the package
// installed, so pull it in explicitly here once for the whole compilation.
/// <reference types="multer" />
