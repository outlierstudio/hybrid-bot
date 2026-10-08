Pod::Spec.new do |s|
  s.name           = 'T3NativeControls'
  s.version        = '1.0.0'
  s.summary        = 'Native UIKit controls for Hybrid mobile.'
  s.description    = 'UIKit-backed controls that match native iOS navigation chrome.'
  s.author         = 'preferedev'
  s.homepage       = 'https://hybrid.preferedev.xyz'
  s.platforms      = {
    :ios => '18.0',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
