/**
 * Public entry point for `@libriant/site`.
 *
 * The static build (`build.ts`) is the site's main job, but the API also needs
 * to render one page at runtime: when the application form fails validation, it
 * re-renders the home page with the visitor's answers and inline errors, so a
 * form with nine questions never has to be retyped and the site keeps working
 * with JavaScript disabled.
 *
 * Only what the API needs is exported. Nothing here reads the filesystem or
 * pulls in `marked` — see the import graph before adding to it.
 */

export { renderIndex, type FieldErrors, type FieldValues, type RenderOptions } from './pages.js';
export {
  LIBRARY_TYPE_OPTIONS,
  HOME,
  FORM,
  ERRORS,
  LIBRARY_TYPE_VALUES,
  type RequiredField,
} from './copy.js';
export { localePath, basePath, type Lang, type SiteConfig } from './shell.js';
