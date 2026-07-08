// let options = [
//     '--publish-quiet',
//     '--require-module ts-node/register',
//     '--require ./tests/steps/**.ts',
//     '--require hooks/test.setup.ts',
//     '--format progress',
//     '--format json:./reports/cucumber_report.json'
// ].join(' ');


// let run_features = [
//     './features/',
//     options,
// ].join(' ');


// module.exports = {
//     test_runner: run_features
// }

module.exports = {
    test_runner: {
        tags: process.env.npm_config_tags || "@smoke",
        formatOptions: {
            snippetInterface: "async-await"
        },
        paths: ["features/**.feature", "features/**/**.feature"],
        // publishQuiet: true,
        dryRun: false,
        require: ["tests/steps/**.ts", "src/hooks/test.setup.ts"],
        requireModule: ["ts-node/register"],
        format: [
            "progress-bar",
            "html:reports/cucumber_report.html",
            "json:reports/cucumber_report.json",
            "rerun:@rerun.txt",
            "allure-cucumberjs/reporter"
        ],
        parallel: 1
    },
    rerun: {
        formatOptions: {
            snippetInterface: "async-await"
        },
        // publishQuiet: true,
        dryRun: false,
        require: ["tests/steps/**.ts", "hooks/test.setup.ts"],
        requireModule: ["ts-node/register"],
        format: [
            "progress-bar",
            "html:reports/cucumber_report.html",
            "json:reports/cucumber_report.json",
            "rerun:@rerun.txt",
            "allure-cucumberjs/reporter"
        ],
        parallel: 2
    }
}
