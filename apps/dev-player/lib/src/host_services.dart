import 'package:weapp_container/weapp_container.dart';

import 'pack_store.dart';
import 'protocol.dart';

/// Host-owned seam for actual account/payment backends. It runs before guest
/// startup and on every authorized pack update, including an in-place update.
abstract interface class PlayerHostServices {
  Future<void> prepare(
    WeappContainerController controller,
    InstalledGeneration pack,
    DeviceCredentials pairing, {
    required bool newOwner,
  });
}

/// The development Player has an authenticated paired publisher, but no host
/// account. Install real OS capabilities with an anonymous application scope.
/// Login/payment remain unavailable until the embedding host supplies handlers.
class DevelopmentDeviceServices implements PlayerHostServices {
  const DevelopmentDeviceServices({this.allowedNetworkOrigins = const []});
  final List<String> allowedNetworkOrigins;

  Map<String, Object?> application(
    InstalledGeneration pack,
    DeviceCredentials pairing,
  ) {
    if (pack.descriptor.projectId != pairing.projectId ||
        (pack.manifest['integrity'] as Map?)?['root'] !=
            pack.descriptor.integrityRoot) {
      throw const PlayerError(
        'ERR_DEV_PROJECT',
        'Host services require a verified pack from the paired project.',
      );
    }
    return {
      'hostAppId': 'weapp-container.dev-player',
      'tenantId': 'development',
      'publisherId': 'paired-sha256:${pairing.fingerprint}',
      'appId': pack.projectKey,
      'environment': 'develop',
      'version': '${pack.descriptor.runId}:${pack.descriptor.generation}',
      'packRoot': pack.descriptor.integrityRoot,
    };
  }

  @override
  Future<void> prepare(
    WeappContainerController controller,
    InstalledGeneration pack,
    DeviceCredentials pairing, {
    required bool newOwner,
  }) async {
    final installation = application(pack, pairing);
    if (!newOwner) {
      await controller.authorizeInstalledPack(installation);
      return;
    }
    final capabilities = await controller.capabilities();
    if ((capabilities['hostServices'] as Map?)?['protocolVersion'] != '1.0') {
      throw const PlayerError(
        'ERR_HOST_SERVICES_VERSION',
        'This Player requires matching preview.6.0 host services runtime artifacts.',
      );
    }
    await controller.configureHostServices({
      'application': installation,
      'account': {'principalId': null, 'epoch': '1'},
      'apis': <String>[],
    });
    await controller.installNativeDeviceApis(
      allowedNetworkOrigins: allowedNetworkOrigins,
    );
  }
}
