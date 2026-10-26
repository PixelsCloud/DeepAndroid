"""Build and install the isolated Android input fixture with the existing SDK."""
import os, pathlib, shutil, subprocess, zipfile, sys

root = pathlib.Path(__file__).resolve().parent.parent
out = root / '.build' / 'control-fixture'
out.mkdir(parents=True, exist_ok=True)
sdk = pathlib.Path(os.environ.get('ANDROID_HOME', 'D:/android/sdk'))
tools = sdk / 'build-tools' / '34.0.0'
android_jar = sdk / 'platforms' / 'android-34' / 'android.jar'
env = dict(os.environ, JAVA_TOOL_OPTIONS='-XX:ActiveProcessorCount=4')
def run(*args):
    subprocess.run([str(arg) for arg in args], cwd=out, env=env, check=True)

classes = out / 'classes'; classes.mkdir(exist_ok=True)
run('javac', '-encoding', 'UTF-8', '-source', '8', '-target', '8', '-classpath', android_jar, '-d', classes, root / 'tests/android/MainActivity.java', root / 'tests/android/AudioFixture.java')
run(tools / 'aapt.exe', 'package', '-f', '-M', root / 'tests/android/AndroidManifest.xml', '-I', android_jar, '-F', out / 'unsigned.apk')
run(tools / 'd8.bat', '--lib', android_jar, '--min-api', '26', '--output', out, *classes.rglob('*.class'))
with zipfile.ZipFile(out / 'unsigned.apk', 'a') as apk: apk.write(out / 'classes.dex', 'classes.dex')
with zipfile.ZipFile(out / 'audio-fixture.jar', 'w') as jar: jar.write(out / 'classes.dex', 'classes.dex')
run(tools / 'zipalign.exe', '-f', '4', out / 'unsigned.apk', out / 'aligned.apk')
key = out / 'fixture.keystore'
if not key.exists(): run('keytool', '-genkeypair', '-keystore', key, '-storepass', 'android', '-keypass', 'android', '-alias', 'fixture', '-keyalg', 'RSA', '-validity', '3650', '-dname', 'CN=PixelsAndroid Local Fixture')
run(tools / 'apksigner.bat', 'sign', '--ks', key, '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--out', out / 'control-fixture.apk', out / 'aligned.apk')
if '--build-only' not in sys.argv:
    run('adb', '-s', 'e2b3b128', 'install', '--no-incremental', '-r', out / 'control-fixture.apk')
    run('adb', '-s', 'e2b3b128', 'shell', 'am', 'start', '-n', 'com.pixelsandroid.controltest/.MainActivity')
print('Fixture built:', out / 'control-fixture.apk')
