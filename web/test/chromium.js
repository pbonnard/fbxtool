/* How the harnesses start Chromium.
 *
 * Rendering has to happen on the CPU: there is no GPU on a build machine, and
 * a driver would make the pixel checks depend on which one. `--use-gl` names a
 * backend that only exists on Linux — on Windows it is accepted, WebGL then
 * reports no renderer, and every draw quietly does nothing, which reads as a
 * failing test rather than a missing flag. Asking ANGLE for SwiftShader is the
 * spelling that works everywhere.
 */
'use strict';

const ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'];

/** Launch a browser with the software renderer, however the machine is set up. */
function launch(chromium, extra = []) {
  return chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [...ARGS, ...extra],
  });
}

module.exports = { ARGS, launch };
