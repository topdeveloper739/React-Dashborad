import alt from '../alt';
import * as _ from 'lodash';
import { IDataSourcePlugin } from './plugins/DataSourcePlugin';
import DialogsActions from '../components/generic/Dialogs/DialogsActions';

export interface IDataSource {
  id: string;
  config : any;
  plugin : IDataSourcePlugin;
  action: any;
  store: any;
  initialized: boolean;
}

export interface IDataSourceDictionary {
  [key: string] : IDataSource;
}

export interface IExtrapolationResult {
  dataSources: { [key: string] : IDataSource };
  dependencies: { [key: string] : any };
}

export class DataSourceConnector {

  private static dataSources: IDataSourceDictionary = {};

  static createDataSource(dataSourceConfig: any, connections: IConnections) {

    var config = dataSourceConfig || {};
    if (!config.id || !config.type) {
      throw new Error('Data source configuration must contain id and type');
    }

    // Dynamically load the plugin from the plugins directory
    var pluginPath = './plugins/' + config.type;
    var PluginClass = require(pluginPath);
    var plugin : any = new PluginClass.default(config, connections);
    
    // Creating actions class
    var ActionClass = DataSourceConnector.createActionClass(plugin);

    // Creating store class
    var StoreClass = DataSourceConnector.createStoreClass(config, plugin, ActionClass);

    DataSourceConnector.dataSources[config.id] = {
      id: config.id,
      config,
      plugin,
      action: ActionClass,
      store: StoreClass,
      initialized: false
    }

    return DataSourceConnector.dataSources[config.id];
  }

  static createDataSources(dsContainer: IDataSourceContainer, connections: IConnections) {
    dsContainer.dataSources.forEach(source => {
      var dataSource = DataSourceConnector.createDataSource(source, connections);
      DataSourceConnector.connectDataSource(dataSource);
    });

    DataSourceConnector.initializeDataSources();
  }

  private static connectDataSource(sourceDS: IDataSource) {
    // Connect sources and dependencies
    sourceDS.store.listen((state) => {

      Object.keys(this.dataSources).forEach(checkDSId => {
        var checkDS = this.dataSources[checkDSId];
        var dependencies = checkDS.plugin.getDependencies() || {};

        let connected = _.find(_.keys(dependencies), dependencyKey => {
          let dependencyValue = dependencies[dependencyKey] || '';
          return (dependencyValue === sourceDS.id || dependencyValue.startsWith(sourceDS.id + ':'));
        })

        if (connected) {

          // Todo: add check that all dependencies are met
          checkDS.action.updateDependencies.defer(state);
        }
      });
    });
  }

  static initializeDataSources() {
    // Call initalize methods
    Object.keys(this.dataSources).forEach(sourceDSId => {
      var sourceDS = this.dataSources[sourceDSId];

      if (sourceDS.initialized) { return; }

      if (typeof sourceDS.action['initialize'] === 'function') {
        sourceDS.action.initialize.defer();
      }

      sourceDS.initialized = true;
    });
  }

  static extrapolateDependencies(dependencies: IStringDictionary, args?: IDictionary): IExtrapolationResult {
    var result: IExtrapolationResult = {
      dataSources: {},
      dependencies: {}
    };
    Object.keys(dependencies).forEach(key => {
      
      // Find relevant store
      let dependsUpon = dependencies[key].split(':');
      let dataSourceName = dependsUpon[0];

      if (dataSourceName === 'args' && args) {

        if (dependsUpon.length < 2) {
          throw new Error('When padding arguments, you need to provide a specific argument name');
        }

        let valueName = dependsUpon[1];
        result.dependencies[key] = args[valueName];
      } else {
        let dataSource = DataSourceConnector.dataSources[dataSourceName];
        if (!dataSource) {
          throw new Error('Could not find data source for depedency ' + dependencies[key]);
        }

        let valueName = dependsUpon.length > 1 ? dependsUpon[1] : dataSource.plugin.defaultProperty;
        var state = dataSource.store.getState();

        result.dependencies[key] = state[valueName];
        result.dataSources[dataSource.id] = dataSource;
      }
    });

    return result;
  }

  static triggerAction(action: string, params: IStringDictionary, args: IDictionary) {
    var actionLocation = action.split(':');

    if (actionLocation.length !== 2) {
      throw new Error(`Action triggers should be in format of "dataSource:action", this is not met by ${action}`);
    }

    var dataSourceName = actionLocation[0];
    var actionName = actionLocation[1];

    if (dataSourceName === 'dialog') {

      var extrapolation = DataSourceConnector.extrapolateDependencies(params, args);

      DialogsActions.openDialog(actionName, extrapolation.dependencies);
    } else {
      
      var dataSource = DataSourceConnector.dataSources[dataSourceName];
      if (!dataSource) {
        throw new Error(`Data source ${dataSourceName} was not found`)
      }

      dataSource.action[actionName].call(dataSource.action, args);
    }
  }

  static getDataSources(): IDataSourceDictionary {
    return this.dataSources;
  }

  static getDataSource(name): IDataSource {
    return this.dataSources[name];
  }

  private static createActionClass(plugin: IDataSourcePlugin) : any {
    class NewActionClass {
      constructor() {}
    };

    plugin.getActions().forEach(action => {

      if (typeof plugin[action] === 'function') {

        // This method will be called with an action is dispatched
        NewActionClass.prototype[action] = function (...args) {

          // Collecting depedencies from all relevant stores
          var extrapolation = DataSourceConnector.extrapolateDependencies(plugin.getDependencies());

          // Calling action with arguments
          var result = plugin[action].call(this, extrapolation.dependencies, ...args) || {};

          // Checking is result is a dispatcher or a direct value
          if (typeof result === 'function') {
            return (dispatch) => {
              result(function (obj) {
                obj = obj || {};
                var fullResult = DataSourceConnector.callibrateResult(obj, plugin);
                dispatch(fullResult);
              });
            }
          } else {
            var fullResult = DataSourceConnector.callibrateResult(result, plugin);
            return fullResult;
          }
        }
      } else {

        // Adding generic actions that are directly proxied to the store
        alt.addActions(action, <any>NewActionClass);
      }
    });

    // Binding the class to Alt and the plugin
    var ActionClass = alt.createActions(<any>NewActionClass);
    plugin.bind(ActionClass);

    return ActionClass;
  }

  private static createStoreClass(config: any, plugin: any, ActionClass: any): any {
    var bindings = [];
    plugin.getActions().forEach(action => {
      bindings.push(ActionClass[action]);
    });
    class NewStoreClass {
      constructor() {
        (<any>this).bindListeners({ updateState: bindings });
      }

      updateState(newData) {
        (<any>this).setState(newData);
      }
    };
    var StoreClass = alt.createStore(NewStoreClass, config.id + '-Store');;

    return StoreClass;
  }

  private static callibrateResult(result: any, plugin: IDataSourcePlugin) : any {

    var defaultProperty = plugin.defaultProperty || 'value';

    // In case result is not an object, push result into an object
    if (typeof result !== 'object') {
      var resultObj = {};
      resultObj[defaultProperty] = result;
      result = resultObj;
    }

    // Callibrate calculated values
    var calculated = plugin._props.calculated;
    var state = DataSourceConnector.dataSources[plugin._props.id].store.getState();

    state = _.extend(state, result);

    if (typeof calculated === 'function') {
      var additionalValues = calculated(state) || {};
      Object.keys(additionalValues).forEach(key => {
        result[key] = additionalValues[key];
      });
    }

    return result;
  }
}