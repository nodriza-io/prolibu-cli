/**
 * Data mapping between Prolibu Stage and Salesforce OpportunityStage
 *
 * reverse: false (default) → Prolibu Stage → Salesforce OpportunityStage
 * reverse: true → Salesforce OpportunityStage → Prolibu Stage
 */

module.exports = {
    // Basic mappings: prolibuField → salesforceField
    stageName: 'MasterLabel',
    stageCode: 'ApiName',
    active: 'IsActive',
    index: 'SortOrder',
    endFlowStage: 'IsClosed',

    // customFields
    // 'customFields.isWon':              'IsWon',
    // 'customFields.forecastCategory':   'ForecastCategoryName',
    // 'customFields.defaultProbability': 'DefaultProbability',
};
