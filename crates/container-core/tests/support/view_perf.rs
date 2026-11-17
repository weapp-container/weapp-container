// Test-only native benchmarks. All timings include the real batched native
// transport and decoding, and are auxiliary evidence rather than host/device gates.
macro_rules! view_native_benchmark {
    ($engine_name:literal, $modern:expr, $legacy:expr, $old:path) => {
        use container_core::{ViewEngine, ViewExecutionBudget, ViewModuleSource, ViewRenderBatch, ViewRenderDocument, ViewRenderTask};
        use serde_json::{json, Value};
        use std::collections::BTreeMap;
        use std::time::{Duration, Instant};

        fn metrics(mut samples: Vec<u128>) -> Value {
            samples.sort_unstable();
            let percentile = |value: usize| samples[((samples.len() * value).div_ceil(100)).saturating_sub(1).min(samples.len()-1)] as u64;
            json!({"samples":samples.len(),"unit":"nanoseconds","p50":percentile(50),"p95":percentile(95),"p99":percentile(99),"min":samples[0] as u64})
        }

        fn rss_kib() -> Option<u64> {
            std::process::Command::new("/bin/ps").args(["-o","rss=","-p",&std::process::id().to_string()]).output().ok()
                .and_then(|output| String::from_utf8(output.stdout).ok())
                .and_then(|output| output.trim().parse().ok())
        }

        #[test]
        #[ignore = "explicit native performance evidence; WEAPP_VIEW_BENCH_* paths required"]
        fn native_view_performance_report() {
            let fixture_path = std::env::var("WEAPP_VIEW_BENCH_FIXTURES").expect("WEAPP_VIEW_BENCH_FIXTURES");
            let fixture_path = std::path::Path::new(&fixture_path);
            let ts_source = std::fs::read_to_string(fixture_path.join("compiled.cjs")).unwrap();
            let js_source = std::fs::read_to_string(fixture_path.join("compiled-js.cjs")).unwrap();
            let baseline_path = std::env::var("WEAPP_VIEW_BENCH_LEGACY_BOOTSTRAP").expect("WEAPP_VIEW_BENCH_LEGACY_BOOTSTRAP from repository HEAD");
            let baseline = std::fs::read_to_string(&baseline_path).unwrap();
            let report_path = std::env::var("WEAPP_VIEW_BENCH_REPORT").expect("WEAPP_VIEW_BENCH_REPORT");
            let samples:usize = std::env::var("WEAPP_VIEW_BENCH_SAMPLES").ok().and_then(|v|v.parse().ok()).unwrap_or(500);
            assert!(samples>=100,"at least 100 samples");
            let cold_samples=40;
            let budget=ViewExecutionBudget::new(Duration::from_secs(3));
            let wxs_source="module.exports = { compute: function(input) { var total = 0; for (var index = 0; index < input.items.length; index++) { total += input.items[index].value * input.factor; } return { total: total, label: 'sum:' + total, count: input.items.length }; } };";
            let items:Vec<Value>=(0..1000).map(|index|json!({"id":index,"value":index+1})).collect();
            let make_module=|source:&str,modern:bool| ViewModuleSource{id:if modern{"modern:benchmark.cjs"}else{"wxs:benchmark.wxs"}.into(),source:source.into(),dependencies:Vec::new(),compilation:None};
            let make_batch=|modern:bool|ViewRenderBatch{
                documents:vec![ViewRenderDocument{document_id:"page.wxml".into(),ast:json!({"version":1,"nodes":[{"kind":"text","value":"{{tools.compute(input).total}}","bindings":[]}]}),bindings:BTreeMap::from([("tools".into(),if modern{"modern:benchmark.cjs"}else{"wxs:benchmark.wxs"}.into())]),compilation:None}],
                tasks:vec![ViewRenderTask{task_id:"render".into(),scope_id:"page".into(),document_id:"page.wxml".into(),data:json!({"input":{"items":items,"factor":3}})}],
            };
            let names=["modernTypescript","modernJavascript","legacyCached","legacyHeadBaseline"];
            let source=[ts_source.as_str(),js_source.as_str(),wxs_source,wxs_source];
            let mut report_rows=Vec::new();
            for index in 0..4 {
                let mut initialize=Vec::new();let mut load=Vec::new();
                for _ in 0..cold_samples {
                    let started=Instant::now();
                    let mut engine=match index {0..=1=>$modern,2=>$legacy,_=>$old(&baseline)};
                    initialize.push(started.elapsed().as_nanos());
                    let module=make_module(source[index],index<2);
                    let started=Instant::now();engine.load_modules(&[module],&budget).unwrap();load.push(started.elapsed().as_nanos());
                }
                report_rows.push(json!({"name":names[index],"initialize":metrics(initialize),"loadModules":metrics(load),"sourceBodyBytes":source[index].len()}));
            }
            let mut engines=[$modern,$modern,$legacy,$old(&baseline)];
            let mut batches=[make_batch(true),make_batch(true),make_batch(false),make_batch(false)];
            for index in 0..4 {engines[index].load_modules(&[make_module(source[index],index<2)],&budget).unwrap();}
            let mut timings:Vec<Vec<u128>>=(0..4).map(|_|Vec::with_capacity(samples)).collect();
            for turn in 0..(samples+100) {
                for slot in 0..4 {
                    let index=(turn+slot)%4;
                    let factor=2+turn%5;
                    batches[index].tasks[0].data["input"]["factor"]=json!(factor);
                    let started=Instant::now();let result=engines[index].render_batch(&batches[index],&budget).unwrap();let elapsed=started.elapsed().as_nanos();
                    assert_eq!(result[0].ast["nodes"][0]["value"],json!((500500*factor).to_string()));
                    if turn>=100 {timings[index].push(elapsed);}
                }
            }
            for (index,samples) in timings.into_iter().enumerate(){report_rows[index]["warmRenderBatch"]=metrics(samples);}
            let ts_ratio=report_rows[0]["warmRenderBatch"]["p95"].as_f64().unwrap()/report_rows[1]["warmRenderBatch"]["p95"].as_f64().unwrap();
            let cache_ratio=report_rows[2]["warmRenderBatch"]["p95"].as_f64().unwrap()/report_rows[3]["warmRenderBatch"]["p95"].as_f64().unwrap();
            let command_output=|program:&str,args:&[&str]|std::process::Command::new(program).args(args).output().ok().map(|o|String::from_utf8_lossy(&o.stdout).trim().to_owned());
            let exe=std::env::current_exe().unwrap();
            let executable_bytes=std::fs::metadata(&exe).unwrap().len();
            let report=json!({
                "schemaVersion":1,"engine":$engine_name,"commit":command_output("git", &["rev-parse","HEAD"]),"workingTreeStatus":command_output("git", &["status","--porcelain"]),
                "environment":{"os":std::env::consts::OS,"arch":std::env::consts::ARCH,"uname":command_output("uname",&["-a"]),"cpu":command_output("sysctl",&["-n","machdep.cpu.brand_string"]),"rustc":command_output("rustc",&["--version"]),"profile":if cfg!(debug_assertions){"debug-test"}else{"release-test"}},
                "method":{"rowCount":1000,"warmupBatches":100,"sampleOrder":"interleaved rotating four variants","initialize":"realm creation and trusted bootstrap compilation/execution","loadModules":"input serialization, native transport, JS factory compilation and reply decoding; unit factory remains lazy","warmRenderBatch":"input serialization, expression evaluation, unit execution, render traversal, output normalization and native result decoding","comparison":"identical inputs/results; TS and handwritten JS both use public pack compiler","limits":["single native desktop process; no DevTools, GPU or devices","process RSS is whole test process with all four engines and allocator history; not incremental runtime memory","test executable size is diagnostic only; not production incremental package size","timings are complete native API batches, not pure JS execution"]},
                "fixtures":{"path":fixture_path.to_string_lossy(),"typescript":serde_json::from_str::<Value>(&std::fs::read_to_string(fixture_path.join("unit.json")).unwrap()).unwrap(),"javascript":serde_json::from_str::<Value>(&std::fs::read_to_string(fixture_path.join("unit-js.json")).unwrap()).unwrap(),"legacyBaselinePath":baseline_path,"legacyBaselineSha256":command_output("shasum",&["-a","256",&baseline_path]).map(|line|line.split_whitespace().next().unwrap_or("").to_owned()),"trustedBootstrapBodyBytes":{"modern":container_core::MODERN_VIEW_SCRIPT_BOOTSTRAP.len(),"legacyCached":container_core::VIEW_SCRIPT_BOOTSTRAP.len(),"legacyHeadBaseline":baseline.len()}},
                "variants":report_rows,"processRssKiB":rss_kib(),"nativeTestExecutable":{"path":exe.to_string_lossy(),"sizeBytes":executable_bytes,"classification":"test-only diagnostic; not production runtime increment"},
                "observedP95Gate":{"maximumRatio":1.05,"typescriptToJavascript":ts_ratio,"typescriptPass":ts_ratio<=1.05,"cachedToLegacyHead":cache_ratio,"cachePass":cache_ratio<=1.05}
            });
            if let Some(parent)=std::path::Path::new(&report_path).parent(){std::fs::create_dir_all(parent).unwrap();}
            std::fs::write(&report_path,serde_json::to_string_pretty(&report).unwrap()+"\n").unwrap();
            eprintln!("native View performance: {}",serde_json::to_string(&report).unwrap());
        }
    }
}
